import { parsePlanningTargetUnits } from '../../../shared/plot-outline-contract'
import type { CharacterProposalChoices } from '../../character-proposal-choices'
import { decodeCharacterIdentityManifest, decodeCharacterDetails, validateCharacterDetail, type CharacterIdentitySlot, type CharacterDetailOutput } from '../../../shared/character-proposal-parser'
import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { defaultCharacterProposalRelationships, defaultCharacterProposalSelections, formatCharacterProposalPreview } from '../character-proposal-preview'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import type { ArchitecturePlanningIntent } from '../../../shared/generation-owner-contract'

import { CANONICAL_PROJECT_DIRECTORY } from '../../../shared/project-format'
import { synopsisFactsFingerprint, type SynopsisCheckpoint } from '../../../shared/plot-outline-checkpoint'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import {
  composePromptSystemRole,
  renderPrompt,
  resolvePromptTemplate,
} from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
  workflowMainProcessError,
} from '../workflow-project-session'
import { characterArchitecturePrompts, promptLanguageText } from '../../prompt-language'
import { stripThinkingTags } from '../workflow-utils'

import { hashAuthorText } from '../../../shared/source-ref'
import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import type { GenerationAttemptReceipt } from '../../generation/generation-harness'
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'

import type { WritingLanguage } from '../../../shared/writing-language'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
  GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
  isGeneratedGlobalGuidanceValid,
  mergeExpandedNovelConfig,
} from '../novel-config-expansion'
import { displayedErrorMessage, englishWithReason, knownAppErrorMessage } from '../../../i18n/app-errors'


// --- 基础工具库 ---

function stepAuthorInputs(context: WorkflowContext, key: 'characters' | 'worldbuilding',
  snapshot: ArchitectureProjectSnapshot, resuming = false): { id: string; text: string }[] {
  const value = (context.data.stepGuidance as Record<string, unknown> | undefined)?.[key]
  const intent: ArchitecturePlanningIntent | undefined = snapshot.planningIntent ?? (resuming || context.mainGenerationRootHandle ? undefined : {
    version: 'architecture-action-v1', priorSteps: [key], synopsisRange: null,
  })
  return [{ id: 'planning:target-units', text: String(parsePlanningTargetUnits(snapshot.targetUnits)) }, { id: 'architecture:author-config', text: JSON.stringify(snapshot.novelConfig) },
    ...(intent ? [{ id: 'architecture:planning-intent', text: JSON.stringify(intent) }] : []),
    ...(typeof value === 'string' ? [{ id: `architecture:step-guidance:${key}`, text: value }] : [])]
}

interface PartialArchData extends SynopsisCheckpoint {
  world_building_generation_handle?: MainGenerationRunHandle
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  /** 世界观输出达到长度上限时保存的未完成候选；不写入正式 worldbuilding。 */
  world_building_partial_result?: string
  world_building_incomplete?: boolean
  /** 候选赖以生成的输入指纹；项目事实变化后禁止自动续写。 */
  world_building_facts_fingerprint?: string
  /** 候选创建时正式世界观的指纹；避免恢复时覆盖后来编辑的完整成果。 */
  world_building_db_hash?: string
  /** 候选实际使用的作者步骤指导；恢复时沿用，不读取新输入。 */
  world_building_step_guidance?: string
  /** 大纲赖以生成的源事实指纹；源事实变化后禁止续写旧检查点。 */
  synopsis_facts_fingerprint?: string
  /** 本批实际使用的作者步骤指导；恢复必须沿用，不读取新输入。 */
  synopsis_step_guidance?: string
}

/** 大纲章节范围。 */
export interface PlotOutlineChapterRange {
  from: number
  to: number
}

/**
 * 情节大纲生成被输出长度中断、且已完成部分已自动保存时抛出的错误。
 * errorCode 供前端识别并展示「继续生成情节大纲」断点续写按钮。
 */
export const PLOT_OUTLINE_RESUME_ERROR_CODE = 'architecture-synopsis-resume-available'

export class PlotOutlineResumeAvailableError extends Error {
  readonly code = PLOT_OUTLINE_RESUME_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'PlotOutlineResumeAvailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * 情节大纲生成途中，冻结的来源（模型设置、作品设定、提示词模板、写作 Skill）被改动，主进程拒绝了下一章。
 * 同一运行无法恢复，errorCode 供运行侧页给出「去架构页重新生成」入口。
 */
export const PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE = 'architecture-synopsis-source-changed'

/**
 * 主进程按冻结来源拒绝下一次请求时抛出的错误码（main-generation-owner.ts assertSourcesCurrent）：
 * 模型设置变了是 GENERATION_SOURCE_CHANGED_MODEL，其余来源是 GENERATION_SOURCE_CHANGED。经 IPC 后 code 属性丢失、
 * 外面还包着「Error invoking remote method …」，只能匹配 message；两侧的断言排除更长的码
 * （如 _DURING_SNAPSHOT、FINALIZATION_GENERATION_SOURCE_CHANGED）。第 1 组有值即为模型设置变了。
 */


export class PlotOutlineSourceChangedError extends Error {
  readonly code = PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlotOutlineSourceChangedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export const WORLD_BUILDING_RESUME_ERROR_CODE = 'architecture-world-building-resume-available'

export class WorldBuildingResumeAvailableError extends Error {
  readonly code = WORLD_BUILDING_RESUME_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'WorldBuildingResumeAvailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 返回可供查看、复制或续写的世界观候选；候选不是正式世界观。 */
export function recoverableWorldBuildingCandidate(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const partial = value as PartialArchData
  if (partial.world_building_incomplete !== true) return ''
  return typeof partial.world_building_partial_result === 'string'
    ? partial.world_building_partial_result.trim()
    : ''
}


/**
 * 批次进度行的双语模板，仅辅助定位本批范围。完整覆盖本批后可附上该行；
 * 缺少进度行不代表截断，附带时范围必须准确，完成判断仍以正文覆盖为准。
 */

/** 从已确认正文中移除批次进度行（成功批次落盘前剔除）。 */

/**
 * 「本批生成范围」指令：批次可任意处于第 from–to 章。当 from > 1 时模型
 * 必须从已有前缀（seed）末尾自然衔接继续写；to < total 时剩余章节只允许
 * 一行占位概览，等待后续批次补齐。
 */


/** 正常结束后以正文覆盖为准；可选自报进度不能与本批冲突。 */


const PLOT_STRUCTURES = new Set<NovelConfig['plotStructure']>([
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
])
const NARRATIVE_POVS = new Set<NovelConfig['narrativePOV']>([
  'third_limited',
  'first_person',
  'third_omniscient',
  'multi_pov',
])
const REQUIRED_CONFIG_TEXT_FIELDS = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
    'globalGuidance',
  'writingStyle',
] as const

type UiText = (zhCNText: string, enUSText: string) => string

function buildNovelConfigJSONContract(
  totalChapters: number,
  wordsPerChapter: number,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(writingLanguage, `【不可变小说配置 JSON 合同】
- 必填且必须为非空字符串的 6 个字段：genre、targetAudience、subGenre、coreOutline、globalGuidance、writingStyle。
- plotStructure 必填，且值必须严格为以下英文枚举之一：three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform。
- narrativePOV 必填，且值必须严格为以下英文枚举之一：third_limited | first_person | third_omniscient | multi_pov。
- totalChapters 与 wordsPerChapter 是作者权威设置，可以省略；totalChapters 若输出必须严格等于 ${totalChapters}；wordsPerChapter 若输出必须严格等于 ${wordsPerChapter}。
- globalGuidance 必须是 4–8 条跨章节长期有效的简短规则，总计不得超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符；禁止逐章列大纲或分配章节区间。
- referenceWorks 可省略；若输出必须是字符串。
- 只输出一个完整 JSON 对象。枚举只允许上述英文值，不得输出中文枚举、近义词、说明文字、Markdown、代码围栏或思考过程。`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeCompleteNovelConfig(
  content: string,
  expectedTotalChapters: number,
  expectedWordsPerChapter: number,
  text: UiText,
): NovelConfig {
  let value: unknown
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    value = JSON.parse(fenced?.[1].trim() ?? trimmed)
  } catch {
    throw new Error(text('AI 返回的小说配置不是完整 JSON 对象', 'The AI novel configuration is not a complete JSON object.'))
  }
  if (!isRecord(value)) throw new Error(text('AI 返回的小说配置必须是 JSON 对象', 'The AI novel configuration must be a JSON object.'))

  const textFields: Record<(typeof REQUIRED_CONFIG_TEXT_FIELDS)[number], string> = {} as never
  for (const field of REQUIRED_CONFIG_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(text(`AI 返回的小说配置缺少非空字段：${field}`, `The AI novel configuration is missing the non-empty field ${field}.`))
    }
    textFields[field] = value[field].trim()
  }
  if (typeof value.plotStructure !== 'string' || !PLOT_STRUCTURES.has(value.plotStructure as NovelConfig['plotStructure'])) {
    throw new Error(text('AI 返回的小说配置包含非法 plotStructure', 'The AI novel configuration has an invalid plotStructure.'))
  }
  if (typeof value.narrativePOV !== 'string' || !NARRATIVE_POVS.has(value.narrativePOV as NovelConfig['narrativePOV'])) {
    throw new Error(text('AI 返回的小说配置包含非法 narrativePOV', 'The AI novel configuration has an invalid narrativePOV.'))
  }
  for (const [field, expected] of [
    ['totalChapters', expectedTotalChapters],
    ['wordsPerChapter', expectedWordsPerChapter],
  ] as const) {
    const candidate = value[field]
    if (candidate !== undefined && (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
      || candidate !== expected
    )) {
      throw new Error(text(
        `AI 返回的小说配置包含无效 ${field}，不得回退或覆盖作者设置`,
        `The AI novel configuration has an invalid ${field}; it may not replace or override the author's setting.`,
      ))
    }
  }
  if (value.referenceWorks !== undefined && typeof value.referenceWorks !== 'string') {
    throw new Error(text('AI 返回的小说配置包含无效 referenceWorks', 'The AI novel configuration has an invalid referenceWorks.'))
  }

  return {
    genre: textFields.genre,
    targetAudience: textFields.targetAudience,
    subGenre: textFields.subGenre,
    totalChapters: expectedTotalChapters,
    wordsPerChapter: expectedWordsPerChapter,
    plotStructure: value.plotStructure as NovelConfig['plotStructure'],
    narrativePOV: value.narrativePOV as NovelConfig['narrativePOV'],
    coreOutline: textFields.coreOutline,

    globalGuidance: textFields.globalGuidance,
    writingStyle: textFields.writingStyle,
    ...(typeof value.referenceWorks === 'string' ? { referenceWorks: value.referenceWorks.trim() } : {}),
  }
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
const MIN_CHARACTER_SLOTS = 3
const MAX_CHARACTER_SLOTS = 8
const CHARACTER_DETAIL_BATCH_SIZE = 3
const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 32_768
function promptUtf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength }

export interface ArchitectureProjectSnapshot {
  targetUnits?: number
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
  planningIntent?: ArchitecturePlanningIntent
}

function assertArchitectureProjectSessionCurrent(
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error(workflowUiText(
      context,
      '当前项目已切换，架构生成已停止以避免写入错误项目',
      'The current project changed, so architecture generation stopped to avoid writing to the wrong project.',
    ))
  }
}

async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
  operationLabel: string,
  fallbackMessage?: string,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, operationLabel, fallbackMessage)
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
  generationRunHandle?: MainGenerationRunHandle,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  const result = generationRunHandle
    ? await ipc.invokeWithProjectSession(projectSession, 'db:project-core-commit-generated', { data: { [key]: cleanContent }, generationRunHandle }, expectedProjectPath)
    : await ipc.invokeWithProjectSession(projectSession, 'db:project-core-update', { [key]: cleanContent }, expectedProjectPath)
  if (!result.success) {
    throw workflowMainProcessError(context, result.error, '故事架构写入数据库失败', 'Failed to write story architecture to the database.')
  }

  // 通知 UI 层实时刷新架构完成状态
  const { globalEventBus } = await import('../../../shared/event-bus')
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName: `${key}.md`,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    const expectedConfig = structuredClone(useProjectStore.getState().currentProject!.novelConfig)
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params, expectedConfig), {
      authorInputs: [{ id: 'config:author-config', text: JSON.stringify(expectedConfig) }, { id: 'config:author-idea', text: this.idea }, { id: 'config:requested-size', text: JSON.stringify({ totalChapters: this.totalChapters, wordsPerChapter: this.wordsPerChapter }) }],
      operation: 'generate-global-config', promptKeys: ['generate_global_config'], skillStages: ['planning'], output: 'structured-data',
      outputOverrides: [{ purpose: 'generate-global-guidance-replacement', output: 'visible-text' }],
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams, expectedConfig: NovelConfig): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const existingConfig = expectedConfig
    callbacks.log(text(
      '正在调度配置专家 AI，准备解析您的脑洞...',
      'Preparing the configuration model to structure your story idea...',
    ))

    const template = await resolvePromptTemplate('generate_global_config', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 generate_global_config 模板',
      'The generate_global_config template was not found.',
    ))

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)
    const configJSONContract = buildNovelConfigJSONContract(
      this.totalChapters,
      this.wordsPerChapter,
      writingLanguage,
    )
    const authorConfigContext = Object.keys(existingConfig).length > 0
      ? promptLanguageText(
          writingLanguage,
          `【作者已有配置】\n以下非空内容和选择是作者权威输入：长文本只能在保留原文的基础上补充，类型、受众、结构与视角选择不得改写。\n${JSON.stringify(existingConfig, null, 2)}`,
        )
      : ''
    const originalTask = [promptBuilder.build(), authorConfigContext, configJSONContract]
      .filter(Boolean)
      .join('\n\n')

    const initial = await this.callLLMResult(
      originalTask,
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'generate-global-config',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    let resultRaw: string
    if (initial.finishReason === 'stop') {
      resultRaw = initial.content
    } else if (initial.finishReason === 'length') {
      callbacks.log(text(
        '首轮配置 JSON 达到输出上限，已丢弃不可信截断内容，正在请求一次完整替代 JSON...',
        'The first configuration JSON reached the output limit. The untrusted truncated response was discarded; requesting one complete replacement JSON...',
      ))
      const replacement = await this.callLLMResult(
        promptLanguageText(
          writingLanguage,
          `上一轮输出因长度限制而中断。上一轮截断内容是不可信数据，已被丢弃，不得引用或续接。\n\n`
            + `【原始任务合同】\n${originalTask}\n\n`
            + '【硬性要求】\n从头完成原始任务，只输出一个完整替代 JSON。不要只补后缀，不要解释、Markdown 或思考过程。',
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: 'generate-global-config-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      if (replacement.finishReason !== 'stop') {
        throw this.createIncompleteCompletionError(replacement.finishReason)
      }
      resultRaw = replacement.content
    } else {
      throw this.createIncompleteCompletionError(initial.finishReason)
    }
    this.assertNotCancelled(context)

    callbacks.log(text(
      '解析完成，正在应用到项目配置...',
      'Parsing is complete; applying the result to the project configuration...',
    ))
    let parsed: NovelConfig
    try {
      parsed = decodeCompleteNovelConfig(resultRaw, this.totalChapters, this.wordsPerChapter, text)
    } catch (e) {
      const detail = displayedErrorMessage(context.uiLocale, e)
      throw new Error(text(
        `AI 返回的小说配置不完整或无效，结果未应用。详细信息：${detail}`,
        `The AI novel configuration was incomplete or invalid, so the result was not applied. Details: ${detail}`,
      ))
    }
    if (!isGeneratedGlobalGuidanceValid(parsed.globalGuidance)) {
      callbacks.log(text(
        '生成的全局写作要求不符合 4–8 条简短规则合同，正在执行唯一一次字段级完整替代。',
        'The generated global guidance did not satisfy the 4–8 short-rule contract; requesting the single field-level replacement.',
      ))
      const replacement = await this.callLLM(
        promptLanguageText(
          writingLanguage,
          `只纠正小说配置中的 globalGuidance 字段。写 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条跨章节长期有效的简短规则，每条独占一行，总计不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符。不得逐章列大纲、分配章节区间或复述核心大纲。只输出规则正文，不要标题、解释、Markdown 或 JSON。\n\n【已验证的其余小说配置，仅作上下文】\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          purpose: 'generate-global-guidance-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      const replacementGuidance = this.stripThinkingTags(replacement).trim()
      if (!isGeneratedGlobalGuidanceValid(replacementGuidance)) {
        throw new Error(text(
          `全局写作要求仍不符合 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条且不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符的合同，配置未应用。`,
          `The global guidance still does not satisfy the ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES}-rule, ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS}-character contract, so the configuration was not applied.`,
        ))
      }
      parsed = { ...parsed, globalGuidance: replacementGuidance }
    }

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未应用',
        'The current project changed, so the generated configuration was not applied.',
      ))
    }
    const generatedConfig = mergeExpandedNovelConfig(existingConfig, parsed)
    const mainOwned = this.requireGenerationExecution().mainOwned
    if (mainOwned) {
      const handle = context.mainGenerationRunHandle
      if (!handle) throw new Error('GENERATION_COMMIT_HANDLE_REQUIRED')
      const committed = await useProjectStore.getState().commitGeneratedNovelConfig(generatedConfig, expectedConfig, projectSession, handle)
      if (!committed) throw new Error('GENERATION_CONFIG_COMMIT_FAILED')
    }
    this.onGenerated(generatedConfig)
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未保存',
        'The current project changed, so the generated configuration was not saved.',
      ))
    }
    const saved = mainOwned || await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log(text(
        'AI 配置生成并保存成功，请检查各字段后点击「生成架构」',
        'The AI configuration was generated and saved. Review the fields, then select Generate architecture.',
      ))
    } else {
      callbacks.log(text(
        'AI 配置生成成功，请检查各字段后点击「立即保存」',
        'The AI configuration was generated. Review the fields, then select Save now.',
      ))
    }
    callbacks.setProgress(100)
    return text('生成的配置已成功应用！', 'The generated configuration was applied successfully.')
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  private readonly artifactReferences: Array<NonNullable<GenerationAttemptReceipt['visibleArtifact']> & { purpose?: string; finishReason: string }> = []

  protected override reportGenerationPromptBudget(callbacks: StepCallbacks, receipt: GenerationAttemptReceipt): void {
    super.reportGenerationPromptBudget(callbacks, receipt)
    if (receipt.visibleArtifact) this.artifactReferences.push({ ...receipt.visibleArtifact,
      purpose: receipt.purpose, finishReason: receipt.finishReason })
  }

  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('character-architecture', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'characters', this.snapshot),
      operation: 'character-architecture', promptKeys: ['character_dynamics'], skillStages: ['planning'], output: 'structured-data',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const promptCopy = characterArchitecturePrompts(writingLanguage)
    const creativeTemplate = await resolvePromptTemplate('character_dynamics', projectSession, writingLanguage)
    if (!creativeTemplate) throw new Error(text(
      '角色规划模板丢失',
      'The character-planning template is missing.',
    ))
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', this.snapshot.expectedProjectPath)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    const outline = config.coreOutline?.trim() || ''

    if (!outline) {
      throw new Error(text(
        '请先填写大纲，再生成角色或世界观',
        'Write the outline before generating characters or the world.',
      ))
    }

    callbacks.log(text('生成角色名单...', 'Generating the cast...'))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）')
    const manifestContext = {
      genre: modelFacts.genre,
      worldbuilding: core?.worldbuilding || missingValue,
      coreOutline: outline,
      globalGuidance: config.globalGuidance || missingValue,
      stepGuidance: ((context.data.stepGuidance as Record<string, string>) || {}).characters || missingValue,
      referenceWorks: config.referenceWorks || missingValue,
    }
    const manifestContextJson = JSON.stringify(manifestContext)
    // The full author material appears exactly once in the structured context below.
    // Template variables point to it so custom guidance cannot double the input budget.
    const templateVariables = {
      core_outline: '见下方作者材料的 coreOutline',
      genre: '见下方作者材料的 genre',
      global_guidance: '见下方作者材料的 globalGuidance',
      step_guidance: '见下方作者材料的 stepGuidance',
      reference_works: '见下方作者材料的 referenceWorks',
      number_of_chapters: String(config.totalChapters),
      world_building: '见下方作者材料的 worldbuilding',
    }
    const creativeSystem = composePromptSystemRole(creativeTemplate, writingLanguage)
    const creativeGuidance = renderPrompt(creativeTemplate, templateVariables, writingLanguage)
    const manifestSystem = `${creativeSystem}\n\n${promptCopy.manifestSystem}`
    const manifestTask = promptCopy.manifestTask(
      manifestContextJson,
      MIN_CHARACTER_SLOTS,
      MAX_CHARACTER_SLOTS,
    )
    const manifestPrompt = creativeGuidance
      ? `${creativeGuidance}\n\n${manifestTask}`
      : manifestTask
    const manifestSection = (sectionName: string, key: keyof typeof manifestContext) => ({
      sectionName,
      messageIndex: 1,
      finalText: JSON.stringify({ [key]: manifestContext[key] }).slice(1, -1),
    })
    const manifestRaw = await this.callLLMWithBoundedCompletion(
      manifestPrompt,
      manifestSystem,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'character-architecture-manifest',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
        promptBudget: {
          limitUtf8Bytes: MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
          sections: [
            {
              sectionName: 'system-instructions',
              messageIndex: 0,
              finalText: manifestSystem,
            },
            manifestSection('genre', 'genre'),
            manifestSection('worldbuilding', 'worldbuilding'),
            manifestSection('core-outline', 'coreOutline'),
            manifestSection('global-guidance', 'globalGuidance'),
            manifestSection('step-guidance', 'stepGuidance'),
            manifestSection('reference-works', 'referenceWorks'),
          ],
        },
      },
      context,
    )
    context.data.characterManifestArtifacts = this.artifactReferences.map(reference => ({ ...reference }))
    const manifestArtifact = this.artifactReferences.at(-1)
    let manifest: CharacterIdentitySlot[]
    try {
      manifest = decodeCharacterIdentityManifest(manifestRaw)
    } catch (error) {
      const detail = displayedErrorMessage(context.uiLocale, error)
      throw new Error(text(
        detail,
        englishWithReason('The character identity manifest was invalid, so no character data was saved.', detail),
      ))
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const manifestById = new Map(manifest.map(slot => [slot.slotId, slot]))
    const detailContract: StructuredBatchContract<CharacterIdentitySlot, CharacterDetailOutput> = {
      buildTask: ({ items, validatedPrefix }) => {
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        const prefix = JSON.stringify(validatedPrefix.map(entry => ({
          slotId: entry.slotId,
          name: entry.name,
          role: entry.role,
          relationships: entry.relationships,
        })))
        const frozenManifest = JSON.stringify({ slots: manifest })
        const slotIds = items.map(slot => slot.slotId).join(', ')
        const detailTask = promptCopy.detailTask({
          context: manifestContextJson,
          manifest: frozenManifest,
          slotIds,
          validatedPrefix: prefix,
        })
        const detailPrompt = creativeGuidance
          ? `${creativeGuidance}\n\n${detailTask}`
          : detailTask
        const detailSystem = `${creativeSystem}\n\n${promptCopy.detailSystem}`
        const detailRequestBytes = promptUtf8Bytes(detailSystem) + promptUtf8Bytes(detailPrompt)
        const fixedDetailRequestBytes = detailRequestBytes - promptUtf8Bytes(prefix)
        return {
          purpose: 'character-architecture-details',
          output: 'structured-data',
          messages: [
            { role: 'system', content: detailSystem },
            {
              role: 'user',
              content: detailPrompt,
            },
          ],
          promptBudget: {
            limitUtf8Bytes: fixedDetailRequestBytes + MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
            sections: [
              {
                sectionName: 'system-instructions',
                messageIndex: 0,
                finalText: detailSystem,
              },
              manifestSection('genre', 'genre'),
              manifestSection('worldbuilding', 'worldbuilding'),
              manifestSection('core-outline', 'coreOutline'),
              manifestSection('global-guidance', 'globalGuidance'),
              manifestSection('step-guidance', 'stepGuidance'),
              manifestSection('reference-works', 'referenceWorks'),
              {
                sectionName: 'identity-manifest',
                messageIndex: 1,
                finalText: frozenManifest,
              },
              {
                sectionName: 'batch-slot-ids',
                messageIndex: 1,
                finalText: slotIds,
              },
              {
                sectionName: 'validated-prefix',
                messageIndex: 1,
                finalText: prefix,
              },
            ],
          },
        }
      },
      inputKey: slot => slot.slotId,
      outputKey: entry => entry.slotId,
      decode: decodeCharacterDetails,
      validateItem: (entry) => {
        const basicError = validateCharacterDetail(entry)
        if (basicError) return basicError
        const slot = manifestById.get(entry.slotId)
        if (!slot || slot.name !== entry.name || slot.role !== entry.role) return '角色详情身份与冻结清单不一致'
        return undefined
      },
    }
    const generationExecution = this.requireGenerationExecution()
    const detailExecution = await createStructuredBatchExecutor({
      contract: detailContract,
      session: injectWritingSkillIntoSession(generationExecution.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: manifest,
      limits: { maxBatchItems: CHARACTER_DETAIL_BATCH_SIZE },
      signal: generationExecution.signal,
    })
    context.data.characterDetailArtifacts = detailExecution.receipt.attempts.flatMap(receipt => receipt.visibleArtifact
      ? [{ ...receipt.visibleArtifact, purpose: receipt.purpose, finishReason: receipt.finishReason }] : [])
    if (!detailExecution.ok) {
      if (detailExecution.failure.terminal) throw detailExecution.failure.terminal
      const diagnostic = detailExecution.failure.diagnostic
      const attempts = detailExecution.receipt.attempts.length > 0
        ? detailExecution.receipt.attempts
            .map(attempt => `purpose=${attempt.purpose ?? 'unknown'} finishReason=${attempt.finishReason}`)
            .join('; ')
        : 'none'
      const failureReceipt = [
        `code=${detailExecution.failure.code}`,
        `reason=${detailExecution.failure.reason ?? 'unknown'}`,
        ...(diagnostic
          ? [`diagnosticCode=${diagnostic.code} diagnosticPath=${diagnostic.path} diagnosticField=${diagnostic.field}`]
          : []),
        `attempts=${attempts}`,
      ].join(' ')
      throw new Error(text(
        `${displayedErrorMessage(context.uiLocale, detailExecution.failure.message)}；角色详情失败收据：${failureReceipt}`,
        `${knownAppErrorMessage(context.uiLocale, detailExecution.failure.message) ?? englishWithReason('Character details failed structural validation and were not saved.', displayedErrorMessage(context.uiLocale, detailExecution.failure.message))} Receipt: ${failureReceipt}`,
      ))
    }
    if (detailExecution.items.length !== manifest.length) {
      throw new Error(text(
        '角色详情未完整覆盖冻结身份清单',
        'Character details did not fully cover the frozen identity manifest.',
      ))
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const handle = context.mainGenerationRunHandle
    const detailArtifacts = (detailExecution.receipt.acceptedArtifacts ?? []).map(({ artifact }) => artifact)
    if (!handle || !manifestArtifact || detailArtifacts.length === 0) throw new Error('CHARACTER_PROPOSAL_GENERATION_ARTIFACT_REQUIRED')
    const artifacts = [...new Map([manifestArtifact, ...detailArtifacts].map(artifact => [artifact.artifactId,
      { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }])).values()]
    const batch = await ipc.invokeWithProjectSession(projectSession, 'character-proposal:stage', {
      source: { kind: 'generation', inputKind: 'architecture', handle, artifacts, manifestArtifactId: manifestArtifact.artifactId },
    })
    context.data.characterProposalBatch = batch
    callbacks.setProgress(100)
    callbacks.log(text('角色提议已保存，等待明确采用；尚未写入正式角色。', 'Character proposals saved for explicit adoption; no formal characters were written.'))
    return formatCharacterProposalPreview(batch, text)
  }
}

export class AdoptGeneratedCharactersCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const session = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(session, context)
    this.assertNotCancelled(context)
    const shown = context.data.characterProposalBatch as CharacterProposalBatch | undefined
    if (!shown) throw new Error('CHARACTER_PROPOSAL_PREVIEW_REQUIRED')
    if (shown.status === 'cancelled') throw new Error('CHARACTER_PROPOSAL_CANCELLED')
    if (shown.status === 'approved') return formatCharacterProposalPreview(shown, (zh, en) => workflowUiText(context, zh, en))
    const choices = context.data.characterProposalChoices as CharacterProposalChoices | undefined
    if (choices && (choices.proposalBatchId !== shown.proposalBatchId || choices.revision !== shown.revision)) throw new Error('CHARACTER_PROPOSAL_CHOICES_STALE')
    const result = await ipc.invokeWithProjectSession(session, 'character-proposal:approve', {
      proposalBatchId: shown.proposalBatchId, expectedRevision: shown.revision,
      operationId: `character-adoption:${context.runId}`, selections: choices?.selections ?? defaultCharacterProposalSelections(shown),
      relationships: choices?.relationships ?? defaultCharacterProposalRelationships(shown),
    })
    context.data.characterProposalBatch = result.batch
    this.notifyRefresh(['characterCards'], session.projectPath, session)
    const text = (zh: string, en: string) => workflowUiText(context, zh, en)
    callbacks.log(text('角色采用决策已保存；身份未明确的提议继续保留。', 'Character decisions saved; unresolved proposals remain available.'))
    return formatCharacterProposalPreview(result.batch, text)
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: { resumeWorldBuilding?: boolean; resumeHandle?: MainGenerationRunHandle } = {},
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    if (this.options.resumeWorldBuilding && !this.options.resumeHandle) throw new Error(workflowUiText(params.context,
      '旧候选没有持久运行记录，仍可查看或复制；请明确重新开始生成。',
      'This legacy candidate has no persistent run record. It remains available to view or copy; explicitly restart generation.',
    ))
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'worldbuilding', this.snapshot, this.options.resumeWorldBuilding),
      operation: 'generate-world-building', promptKeys: ['world_building'], skillStages: ['planning'], output: 'visible-text',
      ...(this.options.resumeWorldBuilding ? { resumeHandle: this.options.resumeHandle } : {}),
      onRunOpened: async handle => {
        const session = requireWorkflowProjectSession(params.context)
        const partial = (params.context.data.partial as PartialArchData) || await loadPartialData(this.snapshot.expectedProjectPath, session)
        partial.world_building_generation_handle = handle
        await savePartialData(this.snapshot.expectedProjectPath, partial, session, 'Save generation run navigation')
        params.context.data.partial = partial
      },
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const outline = config.coreOutline?.trim() || ''

    if (!outline) {
      throw new Error(text(
        '请先填写大纲，再生成角色或世界观',
        'Write the outline before generating characters or the world.',
      ))
    }

    const resumeRequested = this.options.resumeWorldBuilding === true
    callbacks.log(text(
      resumeRequested ? '正在读取世界观未完成候选...' : '生成世界观...',
      resumeRequested ? 'Reading the incomplete worldbuilding candidate...' : 'Generating worldbuilding...',
    ))
    const template = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The worldbuilding template is missing.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）')
    const requestedStepGuidance = ((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || ''
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    let stepGuidance = requestedStepGuidance
    let seedText = ''
    let expectedDbHash = synopsisFactsFingerprint([core?.worldbuilding || ''])

    if (resumeRequested) {
      seedText = this.requireGenerationExecution().mainOwned
        ? (await this.readMainVisibleComposition())?.text ?? ''
        : recoverableWorldBuildingCandidate(partial)
      if (!seedText
        || partial.world_building_step_guidance === undefined
        || !partial.world_building_facts_fingerprint
        || !partial.world_building_db_hash
      ) {
        throw new Error(text(
          '未找到可恢复的世界观候选；正式世界观保持不变，请重新生成。',
          'No recoverable worldbuilding candidate was found. The formal worldbuilding remains unchanged; regenerate instead.',
        ))
      }
      if (this.requireGenerationExecution().mainOwned && typeof (context.data.stepGuidance as Record<string, unknown> | undefined)?.worldbuilding === 'string'
        && requestedStepGuidance !== partial.world_building_step_guidance) throw new Error(text('作者步骤指导已变化，旧候选不能自动续写。', 'The author step guidance changed; the old candidate cannot be resumed automatically.'))
      stepGuidance = partial.world_building_step_guidance
      expectedDbHash = partial.world_building_db_hash
      if (synopsisFactsFingerprint([core?.worldbuilding || '']) !== expectedDbHash) {
        throw new Error(text(
          '正式世界观自候选保存后已变化，旧候选不能自动覆盖新内容；候选仍可查看或复制。',
          'The formal worldbuilding changed after the candidate was saved, so the old candidate cannot overwrite it. The candidate remains available to view or copy.',
        ))
      }
    }

    const factsFingerprint = synopsisFactsFingerprint([
      outline,
      JSON.stringify(config),
      stepGuidance,
      JSON.stringify(template),
    ])
    if (resumeRequested && partial.world_building_facts_fingerprint !== factsFingerprint) {
      throw new Error(text(
        '大纲、小说配置或世界观模板自候选保存后已变化，旧候选不能续到新上下文；候选仍可查看或复制。',
        'The outline, novel configuration, or worldbuilding template changed after the candidate was saved, so the old candidate cannot be continued into the new context. The candidate remains available to view or copy.',
      ))
    }

    if (this.requireGenerationExecution().mainOwned && !resumeRequested) {
      await this.persistWorldBuildingCandidate(projectSession, expectedProjectPath, context, '', factsFingerprint, expectedDbHash, stepGuidance)
    }

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreOutline(outline)
      .withGenre(modelFacts.genre)
      .withCoreSetting(core?.worldbuilding || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(stepGuidance)
    const taskPrompt = promptBuilder.build()
    const systemPrompt = promptBuilder.getSystemRole()
    const llmOptions = {
      purpose: 'generate-world-building',
      reasoningStage: 'planning' as const,
      writingSkillStage: 'planning' as const,
    }
    let result: string
    let persistedCandidate = seedText
    try {
      if (!seedText) {
        const initial = await this.callLLMResult(
          taskPrompt,
          systemPrompt,
          callbacks,
          llmOptions,
          context,
        )
        const candidate = initial.content.trim()
        if (candidate && ['stop', 'length'].includes(initial.finishReason) && this.requireGenerationExecution().mainOwned) {
          const handle = context.mainGenerationRunHandle
          const artifact = initial.receipt.visibleArtifact
          if (!handle || !artifact) throw new Error('GENERATION_COMPOSITION_ARTIFACT_REQUIRED')
          const candidateHash = await hashAuthorText(candidate)
          const composition = await ipc.invokeWithProjectSession(projectSession, 'generation:compose-visible', handle, [artifact.artifactId], candidateHash)
          if (composition.text !== candidate || composition.textHash !== candidateHash) throw new Error('GENERATION_COMPOSITION_RECEIPT_MISMATCH')
        }
        if (initial.finishReason === 'stop') {
          result = candidate
        } else if (initial.finishReason === 'length' && candidate) {
          persistedCandidate = candidate
          await this.persistWorldBuildingCandidate(
            projectSession,
            expectedProjectPath,
            context,
            persistedCandidate,
            factsFingerprint,
            expectedDbHash,
            stepGuidance,
          )
          result = await this.callLLMWithAppendContinuation({
            taskPrompt,
            systemPrompt,
            callbacks,
            context,
            llmOptions,
            seedText: persistedCandidate,
            maxContinuations: 1,
            taskLabel: text('世界观', 'Worldbuilding'),
            onPartialAvailable: mergedText => { persistedCandidate = mergedText.trim() },
          })
        } else {
          throw this.createIncompleteCompletionError(initial.finishReason)
        }
      } else {
        result = await this.callLLMWithAppendContinuation({
          taskPrompt,
          systemPrompt,
          callbacks,
          context,
          llmOptions,
          seedText,
          maxContinuations: 1,
          taskLabel: text('世界观恢复', 'Worldbuilding recovery'),
          onPartialAvailable: mergedText => { persistedCandidate = mergedText.trim() },
        })
      }
    } catch (error) {
      if (context.cancelled) throw error
      if (persistedCandidate) {
        await this.persistWorldBuildingCandidate(
          projectSession,
          expectedProjectPath,
          context,
          persistedCandidate,
          factsFingerprint,
          expectedDbHash,
          stepGuidance,
        )
        const detail = displayedErrorMessage(context.uiLocale, error)
        throw new WorldBuildingResumeAvailableError(text(
          `世界观未能完整生成，已保存未完成候选且未覆盖正式世界观。可查看、复制或稍后续写。原因：${detail}`,
          `Worldbuilding did not complete. The incomplete candidate was saved without overwriting the formal worldbuilding; you can view, copy, or resume it later. Reason: ${detail}`,
        ))
      }
      throw error
    }

    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestTemplate = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestCore = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestProject = useProjectStore.getState().currentProject
    const latestFactsFingerprint = latestProject && latestTemplate
      ? synopsisFactsFingerprint([
          latestProject.novelConfig.coreOutline || '',
          JSON.stringify(latestProject.novelConfig),
          stepGuidance,
          JSON.stringify(latestTemplate),
        ])
      : ''
    const formalWorldBuildingChanged = synopsisFactsFingerprint([
      latestCore?.worldbuilding || '',
    ]) !== expectedDbHash
    const sourceFactsChanged = latestFactsFingerprint !== factsFingerprint
    if (formalWorldBuildingChanged || sourceFactsChanged) {
      await this.persistWorldBuildingCandidate(
        projectSession,
        expectedProjectPath,
        context,
        result,
        factsFingerprint,
        expectedDbHash,
        stepGuidance,
      )
      throw new WorldBuildingResumeAvailableError(text(
        sourceFactsChanged
          ? '世界观生成期间大纲、小说配置或模板已变化，本次结果已保留为候选且未写入正式世界观；可查看或复制候选。'
          : '世界观生成期间正式内容已被修改，本次结果已保留为候选且未覆盖作者修改；可查看或复制候选。',
        sourceFactsChanged
          ? 'The outline, novel configuration, or template changed while worldbuilding was being generated. This result was kept as a candidate and was not written to formal worldbuilding; you can view or copy it.'
          : 'The formal worldbuilding changed while generation was running. This result was kept as a candidate and did not overwrite the author edit; you can view or copy it.',
      ))
    }
    const heading = promptLanguageText(writingLanguage, '世界观')
    await writeArchToDb(
      'worldbuilding',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      this.requireGenerationExecution().mainOwned ? context.mainGenerationRunHandle : undefined,
    )
    this.assertNotCancelled(context)

    partial.world_building_result = result
    delete partial.world_building_partial_result
    delete partial.world_building_incomplete
    delete partial.world_building_facts_fingerprint
    delete partial.world_building_db_hash
    delete partial.world_building_step_guidance
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '世界观已生成并写入数据库',
      'Worldbuilding generated and saved to the database.',
    ))
    return result
  }

  private async persistWorldBuildingCandidate(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    candidate: string,
    factsFingerprint: string,
    dbHash: string,
    stepGuidance: string,
  ): Promise<void> {
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (this.requireGenerationExecution().mainOwned) delete partial.world_building_partial_result
    else partial.world_building_partial_result = candidate
    partial.world_building_incomplete = true
    partial.world_building_facts_fingerprint = factsFingerprint
    partial.world_building_db_hash = dbHash
    partial.world_building_step_guidance = stepGuidance
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      workflowUiText(context, '保存世界观未完成候选', 'Save the incomplete worldbuilding candidate'),
      workflowUiText(context, '保存世界观未完成候选失败', 'Failed to save the incomplete worldbuilding candidate.'),
    )
    context.data.partial = partial
  }
}
