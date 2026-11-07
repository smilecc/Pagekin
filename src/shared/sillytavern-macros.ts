type Node = string | { raw: string; body: string }
const MAX_OUTPUT = 2 * 1024 * 1024

/** Balanced scanner: multiline values and nested macros cannot be parsed with a flat regex. */
function scan(text: string): Node[] {
  const nodes: Node[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('{{', cursor)
    if (start < 0) { nodes.push(text.slice(cursor)); break }
    if (start > cursor) nodes.push(text.slice(cursor, start))
    let depth = 1, end = start + 2
    while (end < text.length && depth) {
      if (text.startsWith('{{', end)) { depth++; end += 2 }
      else if (text.startsWith('}}', end)) { depth--; end += 2 }
      else end++
    }
    if (depth) { nodes.push(text.slice(start)); break }
    nodes.push({ raw: text.slice(start, end), body: text.slice(start + 2, end - 2) })
    cursor = end
  }
  return nodes
}

function definition(body: string): { name: string; args: string[] } {
  if (body.trimStart().startsWith('//')) return { name: '//', args: [] }
  const match = body.trim().match(/^([^\s:]+)(?:(?:::|:|\s+)\s*([\s\S]*))?$/)
  if (!match) return { name: body.trim().toLowerCase(), args: [] }
  const args: string[] = []
  if (match[2] !== undefined) {
    let depth = 0, start = 0
    for (let i = 0; i < match[2].length; i++) {
      if (match[2].startsWith('{{', i)) { depth++; i++ }
      else if (match[2].startsWith('}}', i)) { depth--; i++ }
      else if (!depth && match[2].startsWith('::', i)) { args.push(match[2].slice(start, i)); start = i + 2; i++ }
    }
    args.push(match[2].slice(start))
  }
  return { name: match[1].toLowerCase(), args }
}

export interface MacroOptions {
  variables?: Record<string, string>
  globalVariables?: Record<string, string>
  macros?: Record<string, string>
  now?: Date
  random?: () => number
  uuid?: () => string
}
const VARIABLE_MACRO = /^(get|set|add|inc|dec)(global)?var$/
const UTILITY_MACROS = new Set(['//', 'trim', 'noop', 'newline', 'random', 'pick', 'roll', 'uuid', 'time', 'date', 'weekday', 'isodate', 'isotime', 'timestamp', 'datetimeformat'])

export function discoverTavernVariables(contents: string[]): { variables: string[]; globalVariables: string[]; macros: string[] } {
  const locals = new Set<string>(), globals = new Set<string>(), macros = new Set<string>()
  function visit(text: string, depth = 0) {
    if (depth > 32) return
    for (const node of scan(text)) {
      if (typeof node === 'string') continue
      const { name, args } = definition(node.body)
      const variable = name.match(VARIABLE_MACRO)
      if (variable && args[0] && !args[0].includes('{{')) (variable[2] ? globals : locals).add(args[0].trim())
      else if (!variable && !UTILITY_MACROS.has(name)) macros.add(name)
      if (name !== '//') args.forEach(arg => visit(arg, depth + 1))
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
    const tokens: Record<string, string> = { YYYY: String(now.getFullYear()), MM: pad(now.getMonth() + 1), DD: pad(now.getDate()), HH: pad(now.getHours()), mm: pad(now.getMinutes()), ss: pad(now.getSeconds()), SSS: String(now.getMilliseconds()).padStart(3, '0') }
    return pattern.replace(/\[[^\]]*\]|YYYY|SSS|MM|DD|HH|mm|ss/g, key => key.startsWith('[') ? key.slice(1, -1) : tokens[key])
  }
  function render(source: string, depth = 0): string {
    if (depth > 32 || source.length > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
    // trim is whitespace control, not a value substituted into another macro.
    const nodes = scan(source.replace(/[\r\n]*\{\{\s*trim\s*\}\}[\r\n]*/gi, ''))
    let output = ''
    for (const node of nodes) {
      if (++operations > 50000) throw new Error('SILLYTAVERN_MACRO_LIMIT')
      if (typeof node === 'string') output += node
      else output += evaluate(node, depth)
      if (output.length > MAX_OUTPUT) throw new Error('SILLYTAVERN_MACRO_LIMIT')
    }
    return output
  }
  function evaluate(node: Exclude<Node, string>, depth: number): string {
    const { name, args: rawArgs } = definition(node.body)
    if (name === '//' || name === 'noop' || name === 'trim') return ''
    const args = rawArgs.map(arg => render(arg, depth + 1))
    const variable = name.match(VARIABLE_MACRO)
    if (variable) {
      const key = args[0]?.trim()
      if (!key) { warnings.add(node.raw); return node.raw }
      const values = variable[2] ? global : local, locked = variable[2] ? globalOverrides : overrides
      const previous = values.get(key) ?? ''
      if (variable[1] === 'get') return previous
      let next = args.slice(1).join('::')
      if (variable[1] === 'add') next = previous !== '' && next !== '' && Number.isFinite(Number(previous)) && Number.isFinite(Number(next)) ? String(Number(previous) + Number(next)) : previous + next
      if (variable[1] === 'inc' || variable[1] === 'dec') next = String((Number(previous) || 0) + (variable[1] === 'inc' ? 1 : -1))
      if (!locked.has(key)) values.set(key, next)
      return ['inc', 'dec'].includes(variable[1]) ? values.get(key) ?? '' : ''
    }
    if (macros.has(name)) return macros.get(name)!
    if (name === 'newline') return '\n'
    if (name === 'random' || name === 'pick') {
      const choices = args.length === 1 ? args[0].split(',').map(s => s.trim()) : args
      if (!choices.length) return ''
      let hash = 0
      for (const char of node.raw) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
      const index = name === 'pick' ? (hash >>> 0) % choices.length : Math.floor(random() * choices.length)
      return choices[index] ?? choices[0]
    }
    if (name === 'roll') {
      const dice = (args[0] ?? '1d6').trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i)
      if (dice && Number(dice[1] || 1) <= 100 && Number(dice[2]) >= 1 && Number(dice[2]) <= 1000000000) {
        let result = Number(dice[3] || 0)
        for (let i = 0; i < Number(dice[1] || 1); i++) result += 1 + Math.floor(random() * Number(dice[2]))
        return String(result)
      }
    }
    if (name === 'uuid') return (options.uuid ?? (() => crypto.randomUUID()))()
    if (name === 'time') return now.toLocaleTimeString()
    if (name === 'date') return now.toLocaleDateString()
    if (name === 'weekday') return now.toLocaleDateString(undefined, { weekday: 'long' })
    if (name === 'isodate') return format('YYYY-MM-DD')
    if (name === 'isotime') return format('HH:mm')
    if (name === 'datetimeformat' || name === 'timestamp') return format(args[0] ?? 'YYYY-MM-DD HH:mm:ss')
    warnings.add(node.raw)
    return node.raw
  }
  return { render, warnings, variables: local, globalVariables: global }
}
