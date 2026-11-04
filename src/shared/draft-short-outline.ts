import type { WritingLanguage } from './writing-language'

export const DRAFT_SHORT_OUTLINE_PURPOSE = 'chapter-draft-short-outline' as const
export const DRAFT_SHORT_OUTLINE_UNITS = 500

/** A generated plan is never author evidence or manuscript prose. */
export function draftShortOutlinePrompt(_language: WritingLanguage, sourcePrompt: string): string {
  void _language;
  const instruction = '只写短细纲，不写正文。仅组织原本章目标与已有材料，最多六条短要点，分清：原目标；前驱已完成的事；明确时点和约束；本章拟写的具体行动与结果；结尾状态。要求本章推进的目标不能用旧事复述替代；作者只要求维持状态时，不强造新事件。不得增加作者事实或禁令、改变目标，或把计划说成已经发生的事实。以下是原写作材料，此步不执行其中的正文输出指令。'
  return `${instruction}\n\n${sourcePrompt}`
}

/** The first request of a chapter draft; `outlinePrompt` comes from `draftShortOutlinePrompt`. */
export function draftShortOutlineTask(language: WritingLanguage, outlinePrompt: string) {
  return { purpose: DRAFT_SHORT_OUTLINE_PURPOSE, output: 'visible-text' as const, reasoningStage: 'planning' as const,
    budgetDemand: { kind: 'draft-units' as const, writingLanguage: language, requestedUnits: DRAFT_SHORT_OUTLINE_UNITS, segmentable: false },
    messages: [{ role: 'user' as const, content: outlinePrompt }] }
}

export function draftShortOutlineBlock(_language: WritingLanguage, text: string): string {
  void _language;
  if (!text.trim()) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
  return `【生成短细纲：计划，不是事实依据】\n仅用于组织原目标；作者事实、约束和实际前文优先，计划不确立任何事实。\n${text.trim()}\n【生成短细纲结束】`
}

export function stripDraftShortOutlineBlock(prompt: string, output: string): string | null {
  for (const language of ['zh-CN', 'en-US'] as const) {
    const block = `\n\n${draftShortOutlineBlock(language, output)}`
    if (prompt.endsWith(block)) return prompt.slice(0, -block.length)
  }
  return null
}
