/** The original fields are retained so exporting never discards extension data. */
export interface TavernPrompt {
  identifier: string
  name?: string
  role?: 'system' | 'user' | 'assistant'
  content?: string
  marker?: boolean
  enabled?: boolean
  injection_position?: number
  injection_depth?: number
  injection_order?: number
  injection_trigger?: string[]
  [key: string]: unknown
}
export interface TavernOrder {
  character_id: number
  order: { identifier: string; enabled: boolean; [key: string]: unknown }[]
  [key: string]: unknown
}
export interface TavernPreset {
  prompts: TavernPrompt[]
  prompt_order: TavernOrder[]
  [key: string]: unknown
}
export interface TavernPresetEntry {
  id: string
  name: string
  preset: TavernPreset
  orderId: number
  /** Explicit overrides win over preset assignments; all mutations are request-local. */
  variables: Record<string, string>
  globalVariables: Record<string, string>
  macros: Record<string, string>
}
export interface TavernSettings {
  presets: TavernPresetEntry[]
  activePresetId: string | null
  scope: 'text' | 'all'
}
export const EMPTY_TAVERN_SETTINGS: TavernSettings = { presets: [], activePresetId: null, scope: 'text' }
export const MAX_TAVERN_FILE_BYTES = 5 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function invalid(): never { throw new Error('SILLYTAVERN_PRESET_INVALID') }

/** Validate at both the import and IPC boundaries; no script or regex is executed. */
export function parseTavernPreset(value: unknown): TavernPreset {
  if (!record(value) || !Array.isArray(value.prompts) || !value.prompts.length || value.prompts.length > 1024) invalid()
  const ids = new Set<string>()
  for (const prompt of value.prompts) {
    if (!record(prompt) || typeof prompt.identifier !== 'string' || !prompt.identifier || ids.has(prompt.identifier)
      || (prompt.name !== undefined && typeof prompt.name !== 'string')
      || (prompt.content !== undefined && typeof prompt.content !== 'string')
      || (prompt.role !== undefined && !['system', 'user', 'assistant'].includes(String(prompt.role)))
      || (prompt.marker !== undefined && typeof prompt.marker !== 'boolean')
      || (prompt.enabled !== undefined && typeof prompt.enabled !== 'boolean')
      || (prompt.injection_position !== undefined && prompt.injection_position !== 0 && prompt.injection_position !== 1)) invalid()
    for (const key of ['injection_depth', 'injection_order']) {
      if (prompt[key] !== undefined && (typeof prompt[key] !== 'number' || !Number.isSafeInteger(prompt[key]) || prompt[key] < 0 || prompt[key] > 10000)) invalid()
    }
    if (prompt.injection_trigger !== undefined && (!Array.isArray(prompt.injection_trigger) || prompt.injection_trigger.some(v => typeof v !== 'string'))) invalid()
    ids.add(prompt.identifier)
  }
  if (!Array.isArray(value.prompt_order) || !value.prompt_order.length || value.prompt_order.length > 100) invalid()
  const orderIds = new Set<number>()
  for (const order of value.prompt_order) {
    if (!record(order) || typeof order.character_id !== 'number' || !Number.isSafeInteger(order.character_id)
      || orderIds.has(order.character_id) || !Array.isArray(order.order) || order.order.length > 1024) invalid()
    orderIds.add(order.character_id)
    const seen = new Set<string>()
    for (const item of order.order) {
      if (!record(item) || typeof item.identifier !== 'string' || typeof item.enabled !== 'boolean' || seen.has(item.identifier)) invalid()
      seen.add(item.identifier)
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TAVERN_FILE_BYTES) invalid()
  return structuredClone(value) as unknown as TavernPreset
}

export function importTavernPreset(json: string, name: string, id: string): TavernPresetEntry {
  if (new TextEncoder().encode(json).length > MAX_TAVERN_FILE_BYTES) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(json.replace(/^\uFEFF/, '')) } catch { invalid() }
  const preset = parseTavernPreset(parsed)
  return { id, name: name.replace(/\.json$/i, ''), preset,
    orderId: (preset.prompt_order.find(o => o.character_id === 100001) ?? preset.prompt_order[0]).character_id,
    variables: {}, globalVariables: {}, macros: {} }
}

export function parseTavernSettings(value: unknown): TavernSettings {
  if (value === undefined) return structuredClone(EMPTY_TAVERN_SETTINGS)
  if (!record(value) || !Array.isArray(value.presets) || value.presets.length > 30
    || !['text', 'all'].includes(String(value.scope)) || (value.activePresetId !== null && typeof value.activePresetId !== 'string')) invalid()
  const ids = new Set<string>()
  const presets = value.presets.map((entry): TavernPresetEntry => {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.orderId !== 'number') invalid()
    ids.add(entry.id)
    const preset = parseTavernPreset(entry.preset)
    if (!preset.prompt_order.some(o => o.character_id === entry.orderId)) invalid()
    for (const key of ['variables', 'globalVariables', 'macros']) {
      if (!record(entry[key]) || Object.values(entry[key]).some(v => typeof v !== 'string')) invalid()
    }
    return { id: entry.id, name: entry.name, preset, orderId: entry.orderId,
      variables: { ...entry.variables as Record<string, string> }, globalVariables: { ...entry.globalVariables as Record<string, string> },
      macros: { ...entry.macros as Record<string, string> } }
  })
  if (value.activePresetId !== null && !ids.has(value.activePresetId as string)) invalid()
  return { presets, activePresetId: value.activePresetId as string | null, scope: value.scope as TavernSettings['scope'] }
}

export function activeTavernPreset(settings: TavernSettings): TavernPresetEntry | undefined {
  return settings.presets.find(p => p.id === settings.activePresetId)
}

/** Freeze only execution inputs; opaque extension/provider fields never enter run manifests. */
export function tavernExecutionSettings(settings: TavernSettings): TavernSettings {
  const entry = activeTavernPreset(settings)
  if (!entry) return structuredClone(EMPTY_TAVERN_SETTINGS)
  const prompts = entry.preset.prompts.map(prompt => Object.fromEntries(
    ['identifier', 'name', 'content', 'role', 'marker', 'injection_position', 'injection_depth', 'injection_order', 'injection_trigger']
      .filter(key => prompt[key] !== undefined).map(key => [key, prompt[key]]),
  ) as unknown as TavernPrompt)
  return { scope: settings.scope, activePresetId: entry.id, presets: [{ ...entry, preset: {
    prompts, prompt_order: entry.preset.prompt_order.filter(o => o.character_id === entry.orderId).map(o => ({
      character_id: o.character_id, order: o.order.map(item => ({ identifier: item.identifier, enabled: item.enabled })),
    })),
  } }] }
}
