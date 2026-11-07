import { createTavernMacroRenderer, type MacroOptions } from './sillytavern-macros'
import type { TavernPresetEntry, TavernPrompt } from './sillytavern-preset'

export interface TavernMessage { role: 'system' | 'user' | 'assistant'; content: string }
const MARKERS: Record<string, string> = {
  worldInfoBefore: 'worldinfoBefore', worldInfoAfter: 'worldinfoAfter', charDescription: 'description',
  charPersonality: 'personality', scenario: 'scenario', personaDescription: 'persona', dialogueExamples: 'mesExamples',
}
export const TAVERN_CONTEXT_DEFAULTS: Record<string, string> = {
  user: '作者', char: '写作助手', description: '', personality: '', scenario: '', persona: '',
  worldinfobefore: '', worldinfoafter: '', mesexamples: '', summary: '',
  charprompt: '', charinstruction: '', chardepthprompt: '', charcreatornotes: '', charversion: '',
}

/** Original task messages are never expanded, dropped or deduplicated by content. */
export function composeTavernMessages(entry: TavernPresetEntry, messages: readonly TavernMessage[], options: MacroOptions = {}) {
  const warnings = new Set<string>()
  const firstChat = messages.findIndex(m => m.role !== 'system')
  const prefixLength = firstChat < 0 ? messages.length : firstChat
  const history = messages.slice(prefixLength)
  const last = (role?: string) => [...history].reverse().find(m => !role || m.role === role)?.content ?? ''
  const configured = Object.fromEntries(Object.entries({ ...options.macros, ...entry.macros }).map(([key, value]) => [key.toLowerCase(), value]))
  const character = configured.char ?? TAVERN_CONTEXT_DEFAULTS.char
  const macros = { ...TAVERN_CONTEXT_DEFAULTS, input: last('user'), lastmessage: last(), lastusermessage: last('user'),
    lastcharmessage: last('assistant'), lastmessageid: String(history.length - 1),
    firstincludedmessageid: history.length ? '0' : '', allchatrange: history.length ? `0-${history.length - 1}` : '',
    group: character, groupnotmuted: character, charifnotgroup: character, notchar: configured.user ?? TAVERN_CONTEXT_DEFAULTS.user,
    mesexamplesraw: configured.mesexamples ?? '', ismobile: 'false', lastgenerationtype: 'normal', ...configured }
  const renderer = createTavernMacroRenderer({ pickSeed: entry.id, ...options, macros, variables: entry.variables, globalVariables: entry.globalVariables })
  const prompts = new Map(entry.preset.prompts.map(p => [p.identifier, p]))
  const order = entry.preset.prompt_order.find(o => o.character_id === entry.orderId)
  if (!order) throw new Error('SILLYTAVERN_PRESET_INVALID')
  const relative: (TavernMessage | 'history')[] = []
  const injections: { prompt: TavernPrompt; message: TavernMessage; index: number }[] = []
  let historyIncluded = false
  for (const item of order.order) {
    if (!item.enabled) continue
    const prompt = prompts.get(item.identifier)
    if (!prompt) { warnings.add(`Missing prompt / 缺少条目: ${item.identifier}`); continue }
    if (prompt.injection_trigger?.length && !prompt.injection_trigger.includes('normal')) {
      warnings.add(`Skipped non-normal trigger / 跳过非普通生成触发器: ${prompt.name ?? prompt.identifier}`)
      continue
    }
    if (prompt.marker) {
      if (prompt.identifier === 'chatHistory') {
        if (!historyIncluded) { relative.push('history'); historyIncluded = true }
      } else {
        const key = MARKERS[prompt.identifier]
        if (!key) { warnings.add(`Unsupported marker / 不支持的标记: ${prompt.identifier}`); continue }
        const content = renderer.render(`{{${key}}}`)
        if (content.trim()) relative.push({ role: prompt.role ?? 'system', content })
      }
      continue
    }
    const content = renderer.render(prompt.content ?? '')
    if (!content.trim()) continue
    const message = { role: prompt.role ?? 'system', content }
    if (prompt.injection_position === 1) injections.push({ prompt, message, index: injections.length })
    else relative.push(message)
  }
  if (!historyIncluded) {
    relative.push('history')
    warnings.add('Task messages appended: no enabled Chat History marker / 未启用聊天历史标记，任务消息已追加')
  }
  const roleOrder = { user: 0, assistant: 1, system: 2 }
  injections.sort((a, b) => (b.prompt.injection_depth ?? 4) - (a.prompt.injection_depth ?? 4)
    || roleOrder[a.message.role] - roleOrder[b.message.role]
    || (a.prompt.injection_order ?? 100) - (b.prompt.injection_order ?? 100) || a.index - b.index)
  const withInjections: TavernMessage[] = []
  for (let i = 0; i <= history.length; i++) {
    for (const item of injections) if (Math.max(0, history.length - (item.prompt.injection_depth ?? 4)) === i) withInjections.push(item.message)
    if (i < history.length) withInjections.push(history[i])
  }
  const composed = [...messages.slice(0, prefixLength), ...relative.flatMap(m => m === 'history' ? withInjections : [m])]
  if (composed.reduce((sum, message) => sum + message.content.length, 0) > 4 * 1024 * 1024) throw new Error('SILLYTAVERN_MACRO_LIMIT')
  if (entry.preset.extensions && Object.keys(entry.preset.extensions as object).length) warnings.add('Extensions (including regex scripts) are retained but not executed / 扩展及正则脚本仅保留，不执行')
  for (const macro of renderer.warnings) warnings.add(`Unresolved macro / 未解析宏: ${macro}`)
  return { messages: composed, warnings: [...warnings], variables: Object.fromEntries(renderer.variables), globalVariables: Object.fromEntries(renderer.globalVariables) }
}
