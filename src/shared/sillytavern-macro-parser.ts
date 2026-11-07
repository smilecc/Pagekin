export interface TavernMacroNode {
  raw: string
  body: string
  content?: string
}
export type TavernMacroPart = string | TavernMacroNode

const ALIASES: Record<string, string> = {
  comment: '//', varexists: 'hasvar', globalvarexists: 'hasglobalvar',
  flushvar: 'deletevar', flushglobalvar: 'deleteglobalvar',
}

export function macroDefinition(body: string) {
  const value = body.trimStart().startsWith('#') ? body.trimStart() : body.trim()
  if (value.startsWith('//') && value !== '///') return { name: '//', args: [], preserve: false }
  const match = value.match(/^(#?)([^\s:]+)(?:\s*(?:::|:)|\s+)?([\s\S]*)$/)
  if (!match) return { name: value.toLowerCase(), args: [], preserve: false }
  const name = match[2].toLowerCase(), preserve = match[1] === '#'
  const args: string[] = []
  // A separator followed by an empty value still supplies an argument (setvar::x::).
  const hasArgs = value.slice(match[1].length + match[2].length).length > 0
  if (hasArgs) {
    const rest = match[3]
    let depth = 0, start = 0
    for (let i = 0; i < rest.length; i++) {
      if (rest.startsWith('{{', i)) { depth++; i++ }
      else if (rest.startsWith('}}', i)) { depth--; i++ }
      else if (!depth && rest.startsWith('::', i)) {
        args.push(rest.slice(start, i)); start = i + 2; i++
      }
    }
    args.push(rest.slice(start))
  }
  return { name: Object.hasOwn(ALIASES, name) ? ALIASES[name] : name, args: preserve ? args : args.map(arg => arg.trim()), preserve }
}

function canOpenScope(body: string) {
  const { name, args } = macroDefinition(body)
  if (name === '//') return ['//', 'comment'].includes(body.trim().toLowerCase())
  if (['if', 'setvar', 'setglobalvar', 'addvar', 'addglobalvar'].includes(name)) return args.length === 1
  return ['//', 'trim', 'reverse'].includes(name) && args.length === 0
}

/** Scan balanced braces, then pair supported scoped macros without consuming unmatched tags. */
export function scanTavernMacros(text: string): TavernMacroPart[] {
  const tokens: { node: TavernMacroPart; start: number; end: number }[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('{{', cursor)
    if (start < 0) { tokens.push({ node: text.slice(cursor), start: cursor, end: text.length }); break }
    if (start > cursor) tokens.push({ node: text.slice(cursor, start), start: cursor, end: start })
    let depth = 1, end = start + 2
    while (end < text.length && depth) {
      if (text.startsWith('{{', end)) { depth++; end += 2 }
      else if (text.startsWith('}}', end)) { depth--; end += 2 }
      else end++
    }
    if (depth) { tokens.push({ node: text.slice(start), start, end: text.length }); break }
    tokens.push({ node: { raw: text.slice(start, end), body: text.slice(start + 2, end - 2) }, start, end })
    cursor = end
  }
  const stack: { name: string; index: number }[] = [], pairs = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    const node = tokens[i].node
    if (typeof node === 'string') continue
    const { name } = macroDefinition(node.body)
    if (name.startsWith('/') && name !== '//') {
      const closing = name === '///' ? '//' : name.slice(1)
      let index = stack.length - 1
      while (index >= 0 && stack[index].name !== closing && !(closing === 'comment' && stack[index].name === '//')) index--
      if (index >= 0) { pairs.set(stack[index].index, i); stack.splice(index) }
    } else if (canOpenScope(node.body)) stack.push({ name, index: i })
  }
  const result: TavernMacroPart[] = []
  for (let i = 0; i < tokens.length; i++) {
    const end = pairs.get(i), token = tokens[i]
    if (end !== undefined && typeof token.node !== 'string') {
      result.push({ ...token.node, raw: text.slice(token.start, tokens[end].end), content: text.slice(token.end, tokens[end].start) })
      i = end
    } else result.push(token.node)
  }
  return result
}
