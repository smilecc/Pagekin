/**
 * 工作流前置校验工具
 *
 * 每个生成步骤启动前需要校验上游数据是否就绪，
 * 以防用户在配置不完整的状态下浪费 AI Token。
 *
 * 校验失败时返回 GuardResult { ok: false, message }，
 * 由调用方选择展示方式（弹窗提示 / 日志输出）。
 */

import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { ipc } from './ipc-client'
import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { localize } from '../i18n/core'
import { ARCH_STEP_NAMES } from './architecture-step-selection'
import type { Locale } from '../i18n/types'

import { readPostProcessStatus, getChapterFinalizeScope, getFailedStepLabels } from './workflows/workflow-utils'

export interface GuardResult {
  ok: boolean
  /** 失败时的提示语（给用户看） */
  message?: string
  /** 用于跳转引导的目标动作标识 */
  action?: 'open-config' | 'open-world-building' | 'open-blueprint'
}

function captureGuardProject(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): { project: ProjectData; projectPath: string; projectSession: ProjectSessionContext } | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return { project, projectPath: expectedProjectPath ?? project.path, projectSession }
}

// ===== Guard 1：生成故事架构前 → 校验小说配置 =====

/**
 * 生成故事架构（架构文件）前的前置校验：
 * 要求「大纲」或「世界观」至少填写其中之一。
 */
export function guardArchitectureGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): GuardResult {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { project } = captured
  const { coreOutline, genre } = project.novelConfig

  // 校验：小说配置是否有实质内容
  const hasConfig = !!(
    coreOutline?.trim()
  )

  if (!hasConfig) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        `请先填写「小说配置」中的大纲，AI 才能据此生成故事架构。\n\n当前类型：${genre || '未设置'}`,
        `Fill in the outline in Novel Configuration before generating the story architecture.\n\nCurrent genre: ${genre || 'Not set'}`,
      ),
      action: 'open-config',
    }
  }

  return { ok: true }
}

// ===== Guard 2：生成故事规划前 → 校验故事架构完成度 =====

/**
 * 生成故事规划前的前置校验：
 * 要求已填写大纲，
 * 建议角色与世界观都完成，但允许继续（仅提示警告）。
 */
export async function guardDirectoryGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale?: Locale,
): Promise<GuardResult> {
  // 不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。
  const shown = () => uiLocale ?? useLocaleStore.getState().locale
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(shown(), '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
  // 只记下缺了哪几块，等最后一次查询回来再按当时的语言写出名字。
  const missing: (readonly [string, string])[] = []

  const checkHasContent = (text: string | null | undefined) => text && text.length > 50 && !text.includes('> 待生成')

  const outlineMissing = !captured.project.novelConfig.coreOutline?.trim()
  if (!core || !checkHasContent(core.charactersArch)) missing.push(ARCH_STEP_NAMES.characters)
  if (!core || !checkHasContent(core.worldbuilding)) missing.push(['世界观', 'Worldbuilding'])

  // 大纲是生成故事规划的必要输入
  if (outlineMissing) {
    return {
      ok: false,
      message: localize(
        shown(),
        '请先填写「大纲」，再生成故事规划。',
        'Write the outline before generating story plans.',
      ),
      action: 'open-world-building',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '角色卡不存在（数据库中没有角色记录）。\n\n请先在角色名单页生成角色（会同时建立角色卡），或手动添加角色。',
        'No character cards exist (the database has no character records).\n\nGenerate characters on the cast page (this creates the cards), or add characters manually.',
      ),
    }
  }

  // 其他部分缺失：警告但允许继续
  if (missing.length > 0) {
    const labels = missing.map(label => localize(shown(), ...label))
    return {
      ok: true, // 允许继续，但携带警告信息
      message: localize(
        shown(),
        `注意：以下架构信息尚未生成，故事规划质量可能受影响：\n${labels.map(m => `• ${m}`).join('\n')}\n\n建议先生成完整架构，或继续使用现有内容。`,
        `The following architecture sections have not been generated, which may affect blueprint quality:\n${labels.map(m => `• ${m}`).join('\n')}\n\nGenerate the complete architecture first, or continue with the available content.`,
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 3：章节写稿前 → 校验故事规划存在 =====

/**
 * 章节写稿前的前置校验：
 * 1. 要求 blueprints/ 目录中存在至少一个故事规划 JSON 文件。
 * 2. 如果指定了章节号且 > 1，要求前一章已定稿（存在于 manuscript/ 中），否则上下文会断裂。
 */
export async function guardChapterWriting(
  targetChapterNumber?: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale?: Locale,
): Promise<GuardResult> {
  // 不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。
  const shown = () => uiLocale ?? useLocaleStore.getState().locale
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(shown(), '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectPath)
  if (blueprints.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '尚未生成故事规划（数据库为空）。\n\n请先在「故事规划」中点击「AI 生成故事规划」，让 AI 规划每章内容后，再回来写稿。',
        'No chapter blueprints have been generated (the database is empty).\n\nGenerate chapter blueprints first, then return to draft the chapter.',
      ),
      action: 'open-blueprint',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束：无角色卡则阻断写稿）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '角色卡不存在（数据库中没有角色记录）。\n\nAI 写稿需要角色状态作为上下文，请先在角色名单页生成角色，或手动添加角色。',
        'No character cards exist (the database has no character records).\n\nAI drafting needs character state as context. Generate characters on the cast page, or add characters manually.',
      ),
    }
  }

  // 如果指定了且不是第一章，则必须保证前一章已经存在正文库（定稿状态）
  if (targetChapterNumber && targetChapterNumber > 1) {
    const prevChapter = targetChapterNumber - 1
    const prevDraftMeta = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', prevChapter, projectPath)
    if (!prevDraftMeta) {
      return {
        ok: false,
        message: localize(
          shown(),
          `上下文缺失：第 ${prevChapter} 章尚未定稿！\n\n为了保证 AI 写稿时能读取到连贯的上下文（前章结尾和剧情要点），请必须先前往草稿箱完成第 ${prevChapter} 章的定稿操作。`,
          `Missing context: Chapter ${prevChapter} has not been finalized.\n\nFinalize Chapter ${prevChapter} first so AI drafting can read a continuous context, including the previous ending and plot notes.`,
        ),
      }
    }

    // 不变量 2 的反向约束：前一章定稿后处理必须全部通过
    const prevScope = getChapterFinalizeScope(prevChapter)
    const prevStatus = await readPostProcessStatus(projectPath, prevScope, projectSession)
    if (prevStatus && !prevStatus.allCriticalPassed) {
      const failedLabels = getFailedStepLabels(prevStatus)
      return {
        ok: false,
        message: localize(
          shown(),
          `第 ${prevChapter} 章的定稿后处理未完成！\n\n以下关键步骤失败：\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\n请先在草稿箱中点击「修复定稿」按钮补全数据，否则后续章节的 AI 上下文将不完整。`,
          `Chapter ${prevChapter} finalization post-processing is incomplete.\n\nFailed critical steps:\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\nRepair the finalization from Drafts first, or later chapters will have incomplete AI context.`,
        ),
      }
    }
    // 如果状态文件不存在（旧版定稿）→ 兼容放行
  }

  return { ok: true }
}

// ===== Guard 4：角色卡重新生成前 → 检查故事规划是否为空 =====

/**
 * 角色卡重新生成/补齐的前置校验：
 * 不变量 1：角色卡仅允许在故事规划目录为空时重新生成，
 * 否则会破坏已有故事规划/章节的角色状态链。
 */
export async function guardCharacterRegeneration(
  expectedProjectSession?: ProjectSessionContext,
): Promise<GuardResult> {
  const captured = captureGuardProject(undefined, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(useLocaleStore.getState().locale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const blueprints = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:blueprint-get-all',
    captured.projectPath,
  )
  if (blueprints.length > 0) {
    return {
      ok: false,
      message: localize(
        useLocaleStore.getState().locale,
        '已有故事规划，角色卡不可重新生成。\n\n故事规划生成已依赖角色数据，重新生成角色卡会导致现有故事规划和已写章节全部失效。\n如需修改角色，请手动编辑现有角色卡。',
        'Character cards cannot be regenerated while chapter blueprints exist.\n\nThe blueprints already depend on character data. Regenerating the cards would invalidate existing blueprints and drafted chapters. Edit the existing character cards manually instead.',
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 5：修复定稿后处理前 → 检查这一章有没有要修的步骤 =====

export async function guardRepairPostProcess(
  chapterNumber: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): Promise<GuardResult> {
  const text = (zhCNText: string, enUSText: string) => localize(useLocaleStore.getState().locale, zhCNText, enUSText)
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return { ok: false, message: text('请先打开或新建一个项目。', 'Open or create a project first.') }
  }

  const maxFinalized = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:draft-get-max-finalized-chapter',
    captured.projectPath,
  )
  if (maxFinalized === 0) {
    return { ok: false, message: text('尚无已定稿章节，无法执行修复操作。', 'No chapter has been finalized yet, so there is nothing to repair.') }
  }
  if (chapterNumber === maxFinalized) return { ok: true }

  const status = await readPostProcessStatus(captured.projectPath, getChapterFinalizeScope(chapterNumber), captured.projectSession)
  if (!status || Object.values(status.steps).some(step => !step.ok)) return { ok: true }
  return {
    ok: false,
    message: text(
      `第 ${chapterNumber} 章的定稿后处理已经全部完成，没有需要修复的步骤。`,
      `Post-processing for Chapter ${chapterNumber} has already finished, so there is no step to repair.`,
    ),
  }
}
