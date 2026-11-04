import { writingLanguageText, type WritingLanguage } from '../shared/writing-language'

export interface PromptLanguageTemplate {
  systemRole: string
  content: string
  systemSuffix?: string
}

export interface CharacterArchitecturePromptSet {
  manifestSystem: string
  detailSystem: string
  detailContract: string
  manifestTask(context: string, minimum: number, maximum: number): string
  detailTask(input: {
    context: string
    manifest: string
    slotIds: string
    validatedPrefix: string
  }): string
}

/**
 * Built-in templates used by the forward-writing lifecycle. Every key in this
 * list use the Chinese writing contract.
 */
export const CORE_LOCALIZED_BUILTIN_PROMPT_KEYS = Object.freeze([
  'generate_novel_config_field',
  'edit_selected_text',
  'generate_global_config',
  'character_dynamics',
  'world_building',
  'chapter_blueprint_chunk',
  'first_chapter_draft',
  'next_chapter_draft',
  'refine_chapter',
  'consistency_check',
  'refine_from_review',
  'generate_chapter_notes',
  'update_character_cards',
  'analyze_writing_style',
  'infer_novel_config',
  'extract_initial_characters',
  'infer_novel_config_with_vectors',
  'infer_single_chapter_blueprint',
] as const)

export type CoreLocalizedBuiltinPromptKey = typeof CORE_LOCALIZED_BUILTIN_PROMPT_KEYS[number]

const CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET = new Set<string>(CORE_LOCALIZED_BUILTIN_PROMPT_KEYS)

export function isCoreLocalizedBuiltinPromptKey(key: string): key is CoreLocalizedBuiltinPromptKey {
  return CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET.has(key)
}

const CHARACTER_ARCHITECTURE_PROMPTS: Readonly<Record<'zh-CN', CharacterArchitecturePromptSet>> = {
  'zh-CN': {
    manifestSystem: `你是小说角色身份规划器。只规划角色身份、叙事职责和角色间关系，不生成角色详情。
大纲中的作者明确设定是权威事实；涉及角色身份、特质、关系或叙事职责的事实必须落实，不得遗漏、弱化、反转或用题材惯例替换。
只输出一个可由 JSON.parse 读取的 {"slots":[...]} 对象，不得输出 Markdown、解释、代码围栏或思考过程。`,
    detailSystem: `你是小说角色详情生成器。只为指定的冻结角色身份补全紧凑资料，不规划或改写角色身份和关系。
大纲中的作者明确设定是权威事实；必须写入相关角色详情，不得遗漏、弱化、反转或用题材惯例替换。
只输出一个可由 JSON.parse 读取的 {"entries":[...]} 对象，不得输出 schemaVersion、relationships、Markdown、解释、代码围栏或思考过程。`,
    detailContract: `【不可变角色详情 JSON 合同】
只输出 {"entries":[...]}。每项必须包含 slotId、name、role、gender、age、appearance、personality、background、abilities、motivation、arc、notes、currentState。
currentState 必填，必须包含 location、powerLevel、physicalState、mentalState、keyItems、recentEvents、updatedAtChapter；updatedAtChapter 必须是非负整数。
appearance、personality、background、abilities、motivation、arc、notes 每项不超过 120 字符；currentState 的文本字段每项不超过 80 字符。
keyItems 可为非空字符串或非空字符串数组；recentEvents 可为非空字符串或非空字符串数组。数组每项必须是非空字符串，不得混入数字、对象或 null；没有内容时使用字符串“无”，不得输出空数组。
禁止输出 relationships、schemaVersion、角色图谱 Markdown、解释、代码围栏或思考过程。`,
    manifestTask: (context, minimum, maximum) => `【身份规划上下文】
${context}

【身份清单合同】
只输出 {"slots":[...]}，角色数量必须为 ${minimum}–${maximum}。每项必须含 slotId、name、role、narrativeDuty、relations；relations 每项含 targetSlotId、relation。slotId 与 targetSlotId 必须是 JSON 字符串；slotId/name 必须唯一，role 仅 protagonist/antagonist/supporting/minor，且至少一个 protagonist；关系只能引用本清单其他 slotId。`,
    detailTask: input => `【角色详情上下文】
${input.context}

${CHARACTER_ARCHITECTURE_PROMPTS['zh-CN'].detailContract}

【冻结身份与关系清单】
${input.manifest}

【本批必须完整生成的 slotId】
${input.slotIds}

【已验证详情前缀】
${input.validatedPrefix}

【详情精炼要求】
保持每个字段具体、紧凑且与叙事有关；currentState 必填。禁止输出 relationships，关系由冻结身份清单唯一生成。

只输出 {"entries":[...]}。每项必须额外回显 slotId，name/role 必须与冻结清单完全一致。不得复制、改写或补充关系。`,
  },
}

export function characterArchitecturePrompts(_language: WritingLanguage): CharacterArchitecturePromptSet {
  void _language;
  return CHARACTER_ARCHITECTURE_PROMPTS['zh-CN']
}

export function promptLanguageText(
  language: WritingLanguage,
  zhCNText: string,
  _unused?: string,
): string {
  void _unused;
  return writingLanguageText(language, zhCNText)
}
