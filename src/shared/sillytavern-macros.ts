import { macroDefinition as definition, scanTavernMacros as scan, type TavernMacroNode } from './sillytavern-macro-parser'

const MAX_OUTPUT = 2 * 1024 * 1024
export interface MacroOptions {
  variables?: Record<string, string>
  globalVariables?: Record<string, string>
  macros?: Record<string, string>
  now?: Date
  random?: () => number
  uuid?: () => string
  /** Stable request/preset identity; pick also incorporates source text and position. */
  pickSeed?: string
}
const VARIABLE_MACRO = /^(get|set|add|inc|dec|has|delete)(global)?var$/
const SHORTHAND = /^([.$])([^\s:{}=+*/!?<>|]+)$/u
const UTILITY_MACROS = new Set(['//', 'trim', 'noop', 'newline', 'space', 'reverse', 'if', 'else', 'random', 'pick', 'roll', 'uuid', 'time', 'date', 'weekday', 'isodate', 'isotime', 'timestamp', 'datetimeformat', 'hasextension'])
const OPTIONAL_ARG_MACROS = new Set(['trim', 'noop', 'newline', 'space', 'random', 'pick', 'uuid', 'time', 'date', 'weekday', 'isodate', 'isotime'])

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return hash >>> 0
}

/** Reproducible, varied preview values. Real requests use Math.random instead. */
export function createTavernPreviewRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function discoverTavernVariables(contents: string[]): { variables: string[]; globalVariables: string[]; macros: string[] } {
  const locals = new Set<string>(), globals = new Set<string>(), macros = new Set<string>()
  function visit(text: string, depth = 0) {
    if (depth > 32) return
    for (const node of scan(text)) {
      if (typeof node === 'string') continue
      const { name, args } = definition(node.body)
      if (name === '//') continue
      const variable = name.match(VARIABLE_MACRO), shorthand = node.body.trim().match(SHORTHAND)
      if (shorthand) (shorthand[1] === '$' ? globals : locals).add(shorthand[2])
      else if (variable && args[0] && !args[0].includes('{{')) (variable[2] ? globals : locals).add(args[0].trim())
      else if (!variable && !UTILITY_MACROS.has(name)) macros.add(name)
      if (name === 'if' && args[0]) {
        const condition = args[0].replace(/^!\s*/, '')
        if (SHORTHAND.test(condition)) visit(`{{${condition}}}`, depth + 1)
        else if (/^[a-z][a-z0-9_]*$/i.test(condition) && !['true', 'false', 'on', 'off'].includes(condition.toLowerCase()) && !UTILITY_MACROS.has(condition.toLowerCase())) macros.add(condition.toLowerCase())
      }
      args.forEach(arg => visit(arg, depth + 1))
      if (node.content !== undefined) visit(node.content, depth + 1)
    }
  }
  contents.forEach(content => visit(content))
  return { variables: [...locals], globalVariables: [...globals], macros: [...macros] }
}

export function createTavernMacroRenderer(options: MacroOptions = {}) {
  const local = new Map(Object.entries(options.variables ?? {})), global = new Map(Object.entries(options.globalVariables ?? {}))
  const overrides = new Set(Object.keys(options.variables ?? {})), globalOverrides = new Set(Object.keys(options.globalVariables ?? {}))
  const macros = new Map(Object.entries(options.macros ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  const warnings = new Set<string>()
  const now = options.now ?? new Date(), random = options.random ?? Math.random
  let operations = 0
  function format(pattern: string) {
    const pad = (n: number) => String(n).padStart(2, '0')
    const tokens: Record<string, string> = {
      YYYY: String(now.getFullYear()), YY: String(now.getFullYear()).slice(-2),
      M: String(now.getMonth() + 1), MM: pad(now.getMonth() + 1), MMM: now.toLocaleString(undefined, { month: 'short' }), MMMM: now.toLocaleString(undefined, { month: 'long' }),
      D: String(now.getDate()), DD: pad(now.getDate()), d: String(now.getDay()), ddd: now.toLocaleString(undefined, { weekday: 'short' }), dddd: now.toLocaleString(undefined, { weekday: 'long' }),
      H: String(now.getHours()), HH: pad(now.getHours()), h: String(now.getHours() % 12 || 12), hh: pad(now.getHours() % 12 || 12),
      m: String(now.getMinutes()), mm: pad(now.getMinutes()), s: String(now.getSeconds()), ss: pad(now.getSeconds()),
      SSS: String(now.getMilliseconds()).padStart(3, '0'), A: now.getHours() < 12 ? 'AM' : 'PM', a: now.getHours() < 12 ? 'am' : 'pm',
      X: String(Math.floor(now.getTime() / 1000)), x: String(now.getTime()),
    }
    return pattern.replace(/\[[^\]]*\]|YYYY|MMMM|dddd|MMM|ddd|SSS|YY|MM|DD|HH|hh|mm|ss|[MDdHhmsAaXx]/g, key => key.startsWith('[') ? key.slice(1, -1) : tokens[key])
  }
  function unresolved(node: TavernMacroNode) { warnings.add(node.raw); return node.raw }
  function render(source: string, depth = 0, path = ''): string {
    if (depth > 32 || source.length > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
    // Legacy names are expanded only in source, never in substituted user values.
    const legacy: Record<string, string> = { USER: 'user', BOT: 'char', CHAR: 'char', GROUP: 'group', CHARIFNOTGROUP: 'charifnotgroup' }
    const nodes = scan(source.replace(/<(USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/g, (_, key: string) => `{{${legacy[key]}}}`))
    const contentHash = hashString(source)
    let output = '', offset = 0, trimNext = false
    for (const node of nodes) {
      if (++operations > 50000) throw new Error('SILLYTAVERN_MACRO_LIMIT')
      if (typeof node !== 'string' && definition(node.body).name === 'trim' && node.content === undefined) {
        output = output.replace(/[\r\n]+$/, ''); trimNext = true
      } else {
        const value = typeof node === 'string' ? node : evaluate(node, depth, `${path}:${contentHash}:${offset}`)
        output += trimNext ? value.replace(/^[\r\n]+/, '') : value
        trimNext = false
      }
      offset += typeof node === 'string' ? node.length : node.raw.length
      if (output.length > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
    }
    return output
  }
  function evaluate(node: TavernMacroNode, depth: number, position: string): string {
    const { name, args: rawArgs, preserve } = definition(node.body)
    if (name === '//' || name === 'noop') return ''
    const shorthand = node.body.trim().match(SHORTHAND)
    if (shorthand) return (shorthand[1] === '$' ? global : local).get(shorthand[2]) ?? ''
    if (name === 'if') {
      const content = node.content ?? rawArgs[1]
      if (!rawArgs.length || content === undefined) return unresolved(node)
      let condition = rawArgs[0].trim(), invert = false
      if (condition.startsWith('!')) { invert = true; condition = condition.slice(1).trimStart() }
      condition = render(condition, depth + 1, `${position}:condition`).trim()
      const key = condition.match(SHORTHAND)
      if (key) condition = (key[1] === '$' ? global : local).get(key[2]) ?? ''
      else if (macros.has(condition.toLowerCase())) condition = macros.get(condition.toLowerCase())!
      else if (OPTIONAL_ARG_MACROS.has(condition.toLowerCase())) condition = render(`{{${condition}}}`, depth + 1, `${position}:condition-value`)
      const truthy = !['', 'false', 'off', '0'].includes(condition.toLowerCase())
      // scan groups nested scopes, so only a top-level else divides the branches.
      let thenBranch = '', elseBranch = '', inElse = false
      for (const part of scan(content)) {
        if (typeof part !== 'string' && definition(part.body).name === 'else') { inElse = true; continue }
        const raw = typeof part === 'string' ? part : part.raw
        if (inElse) elseBranch += raw; else thenBranch += raw
      }
      const result = render(truthy !== invert ? thenBranch : elseBranch, depth + 1, `${position}:branch`)
      return preserve ? result : result.trim()
    }
    const args = [...rawArgs, ...(node.content === undefined ? [] : [preserve ? node.content : node.content.trim()])].map((arg, index) => render(arg, depth + 1, `${position}:${index}`))
    const variable = name.match(VARIABLE_MACRO)
    if (variable) {
      const key = args[0]?.trim()
      if (!key) return unresolved(node)
      const values = variable[2] ? global : local, locked = variable[2] ? globalOverrides : overrides
      const previous = values.get(key) ?? ''
      if (variable[1] === 'get') return previous
      if (variable[1] === 'has') return String(values.has(key))
      if (variable[1] === 'delete') { if (!locked.has(key)) values.delete(key); return '' }
      let next = args.slice(1).join('::')
      if (variable[1] === 'add') next = previous !== '' && next !== '' && Number.isFinite(Number(previous)) && Number.isFinite(Number(next)) ? String(Number(previous) + Number(next)) : previous + next
      if (variable[1] === 'inc' || variable[1] === 'dec') next = String((Number(previous) || 0) + (variable[1] === 'inc' ? 1 : -1))
      if (next.length > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
      if (!locked.has(key)) values.set(key, next)
      return ['inc', 'dec'].includes(variable[1]) ? values.get(key) ?? '' : ''
    }
    if (macros.has(name)) return macros.get(name)!
    if (name === 'trim') return (args[0] ?? '').trim()
    if (name === 'reverse') return Array.from(args[0] ?? '').reverse().join('')
    if (name === 'newline' || name === 'space') {
      const count = args.length ? Number(args[0]) : 1
      if (!Number.isSafeInteger(count) || count < 0) return unresolved(node)
      if (count > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
      return (name === 'newline' ? '\n' : ' ').repeat(count)
    }
    if (name === 'hasextension') return 'false' // Extensions are retained on import, never loaded.
    if (name === 'random' || name === 'pick') {
      // Legacy single-argument lists allow escaped commas. :: takes precedence.
      const choices = args.length === 1
        ? args[0].includes('::') ? args[0].split('::').map(s => s.trim()) : args[0].split(/(?<!\\),/).map(s => s.replace(/\\,/g, ',').trim())
        : args
      if (!choices.length) return ''
      const index = name === 'pick' ? hashString(`${options.pickSeed ?? ''}:${position}:${node.raw}`) % choices.length : Math.floor(random() * choices.length)
      return choices[index] ?? choices[0]
    }
    if (name === 'roll') {
      const formula = (args[0] ?? '1d6').trim()
      const dice = (/^\d+$/.test(formula) ? `1d${formula}` : formula).match(/^(\d*)d(\d+)([+-]\d+)?$/i)
      if (dice && Number(dice[1] || 1) >= 1 && Number(dice[1] || 1) <= 100 && Number(dice[2]) >= 1 && Number(dice[2]) <= 1000000000) {
        let result = Number(dice[3] || 0)
        for (let i = 0; i < Number(dice[1] || 1); i++) result += 1 + Math.floor(random() * Number(dice[2]))
        if (Number.isSafeInteger(result)) return String(result)
      }
      return unresolved(node)
    }
    if (name === 'uuid') return (options.uuid ?? (() => crypto.randomUUID()))()
    if (name === 'time') {
      const offset = args[0]?.match(/^UTC([+-]\d+)$/i)
      if (offset) {
        const hours = Number(offset[1])
        if (Math.abs(hours) > 23) return unresolved(node)
        return new Date(now.getTime() + hours * 3600000).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
      }
      return now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    if (name === 'date') return now.toLocaleDateString()
    if (name === 'weekday') return now.toLocaleDateString(undefined, { weekday: 'long' })
    if (name === 'isodate') return format('YYYY-MM-DD')
    if (name === 'isotime') return format('HH:mm')
    if (name === 'datetimeformat' || name === 'timestamp') return format(args[0] ?? 'YYYY-MM-DD HH:mm:ss')
    return unresolved(node)
  }
  return { render, warnings, variables: local, globalVariables: global }
}
