import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importTavernPreset, parseTavernPreset, parseTavernSettings, type TavernPrompt } from '../sillytavern-preset'
import { createTavernMacroRenderer, createTavernPreviewRandom, discoverTavernVariables } from '../sillytavern-macros'
import { composeTavernMessages, type TavernMessage } from '../sillytavern-compose'

function entry(prompts: TavernPrompt[]) {
  return importTavernPreset(JSON.stringify({ prompts, prompt_order: [{ character_id: 100001,
    order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] }), 'test.json', 'test')
}
describe('SillyTavern preset import and rendering', () => {
  it('renders the Éclat·Turing preset with all 1,358 random macros and varied noise characters', () => {
    const json = readFileSync(new URL('../../../docs/我即浪潮-1105-Éclat·Turing.json', import.meta.url), 'utf8')
    const preset = importTavernPreset(json, 'Éclat·Turing.json', 'wave')
    expect(preset.preset).toEqual(JSON.parse(json))
    expect(preset.preset.prompts).toHaveLength(148)
    const random = createTavernPreviewRandom(1)
    let calls = 0
    const result = composeTavernMessages(preset, [{ role: 'user', content: '继续写作' }], { random: () => { calls++; return random() } })
    expect(calls).toBe(1358)
    expect(result.warnings.filter(w => w.startsWith('Unresolved macro'))).toEqual([])
    const output = result.messages.map(m => m.content).join('\n')
    expect(output).not.toMatch(/\{\{(?:random|setvar|getvar|user|\/\/)/i)
    const noise = output.match(/[א-ת]/gu) ?? []
    expect(noise.length).toBeGreaterThan(500)
    expect(new Set(noise).size).toBeGreaterThan(15)
    const again = composeTavernMessages(preset, [], { random: createTavernPreviewRandom(2) })
    expect(again.messages[0].content).not.toBe(result.messages[0].content)
    expect(discoverTavernVariables(preset.preset.prompts.map(p => p.content ?? '')).macros).not.toContain('random')
  })
  it('accepts whitespace, legacy escaped commas, nested choices and numeric dice', () => {
    const renderer = createTavernMacroRenderer({ random: () => 0, macros: { user: 'A::B, C' } })
    expect(renderer.render('{{ random :: first :: second }}')).toBe('first')
    expect(renderer.render('{{random red\\, blue, green}}')).toBe('red, blue')
    expect(renderer.render('{{random:a::b}}')).toBe('a')
    expect(renderer.render('{{random::{{user}}::other}}')).toBe('A::B, C')
    expect(renderer.render('{{roll::6}}/{{roll::2d6-1}}')).toBe('1/1')
    expect(renderer.render('{{roll::0d6}}')).toBe('{{roll::0d6}}')
  })
  it('handles whitespace counts, Unicode reversal, scoped trim, aliases and locked variables', () => {
    const renderer = createTavernMacroRenderer({ variables: { locked: 'keep' }, globalVariables: { locked: 'global' } })
    expect(renderer.render('A{{space::2}}B{{newline::2}}C{{space::0}}{{reverse::你🙂好}}')).toBe('A  B\n\nC好🙂你')
    expect(renderer.render('{{trim}}  Hello  {{/trim}}')).toBe('Hello')
    expect(renderer.render('{{setvar::x::}}{{hasvar::x}}/{{varexists::missing}}{{flushvar::x}}{{hasvar::x}}')).toBe('true/falsefalse')
    expect(renderer.render('{{setglobalvar::x::1}}{{globalvarexists::x}}{{flushglobalvar::x}}{{hasglobalvar::x}}')).toBe('truefalse')
    expect(renderer.render('{{deletevar::locked}}{{deleteglobalvar::locked}}{{.locked}}/{{$locked}}')).toBe('keep/global')
    expect(renderer.render('{{comment::{{setvar::x::bad}}}}{{//}}ignored {{setvar::x::bad}}{{///}}{{getvar::x}}')).toBe('')
    expect(renderer.render('{{setvar::scoped}} first {{reverse::ab}} {{/setvar}}{{getvar::scoped}}')).toBe('first ba')
    expect(renderer.render('{{#setvar::spaced::  padded  }}[{{getvar::spaced}}]')).toBe('[  padded  ]')
    expect(renderer.render('{{space::-1}}')).toBe('{{space::-1}}')
    expect(() => renderer.render('{{newline::999999999}}')).toThrow('SILLYTAVERN_MACRO_LIMIT')
  })
  it('evaluates only the selected conditional branch, including nested scopes and shorthand conditions', () => {
    const renderer = createTavernMacroRenderer({ macros: { description: '', user: 'Alice' } })
    expect(renderer.render('{{if description}}yes{{else}}no{{/if}}')).toBe('no')
    expect(renderer.render('{{if noop}}bad{{else}}empty{{/if}}')).toBe('empty')
    expect(renderer.render('{{if !description}} {{user}} {{/if}}')).toBe('Alice')
    expect(renderer.render('{{if false}}{{setvar::x::wrong}}{{else}}{{setvar::x::right}}{{/if}}{{.x}}')).toBe('right')
    expect(renderer.render('{{if .x}}A{{if 0}}bad{{else}}B{{/if}}{{else}}bad{{/if}}')).toBe('AB')
    expect(renderer.render('{{if false::{{incvar::n}}}}{{getvar::n}}')).toBe('')
    expect(renderer.render('{{if true::{{if false::bad}}ok}}')).toBe('ok')
    expect(renderer.render('{{#if true}}  spaced  {{/if}}')).toBe('  spaced  ')
    expect(renderer.render('{{if true}}unclosed')).toBe('{{if true}}unclosed')
    expect(() => renderer.render('{{if true}}'.repeat(40) + 'x' + '{{/if}}'.repeat(40))).toThrow('SILLYTAVERN_MACRO_LIMIT')
  })
  it('discovers conditional and shorthand variables without exposing utility macros as editable fields', () => {
    expect(discoverTavernVariables(['{{if .标志}}{{hasvar::字数}}{{else}}{{$世界}}{{/if}}{{if description}}text{{/if}}{{comment}}{{getvar::hidden}}{{/comment}}{{space::2}}{{reverse::abc}}'])).toEqual({ variables: ['标志', '字数'], globalVariables: ['世界'], macros: ['description'] })
  })
  it('keeps pick stable by seed and position while random previews can be rerolled', () => {
    const source = Array(20).fill('{{pick::a::b::c::d::e::f}}').join(' ')
    const first = createTavernMacroRenderer({ pickSeed: 'first' }).render(source)
    expect(createTavernMacroRenderer({ pickSeed: 'first' }).render(source)).toBe(first)
    expect(createTavernMacroRenderer({ pickSeed: 'second' }).render(source)).not.toBe(first)
    expect(new Set(first.split(' ')).size).toBeGreaterThan(1)
    const randomSource = source.replaceAll('pick', 'random')
    const preview = (seed: number) => createTavernMacroRenderer({ random: createTavernPreviewRandom(seed) }).render(randomSource)
    expect(preview(1)).toBe(preview(1))
    expect(preview(1)).not.toBe(preview(2))
  })
  it('supports UTC time offsets, additional date tokens, single-chat aliases and legacy names', () => {
    const now = new Date('2026-11-07T13:05:09.123Z')
    const renderer = createTavernMacroRenderer({ now })
    expect(renderer.render('{{time::UTC+8}}')).toBe(new Date('2026-11-07T21:05:09.123Z').toLocaleTimeString(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }))
    expect(renderer.render('{{datetimeformat::[epoch] X x}}')).toBe(`epoch ${Math.floor(now.getTime() / 1000)} ${now.getTime()}`)
    const preset = entry([{ identifier: 'main', content: '<USER>/<BOT>/{{group}}/{{notChar}}/{{allChatRange}}/{{firstIncludedMessageId}}/{{hasExtension::regex}}/{{lastGenerationType}}' }])
    preset.macros = { User: '作者甲', Char: '助手乙' }
    expect(composeTavernMessages(preset, [{ role: 'user', content: 'task' }]).messages[0].content).toBe('作者甲/助手乙/助手乙/作者甲/0-0/0/false/normal')
  })
  it('imports the supplied 1.99 preset losslessly and resolves its active variable modules', () => {
    const json = readFileSync(new URL('../../../docs/1.99__.json', import.meta.url), 'utf8')
    const preset = importTavernPreset(json, '1.99__.json', 'sample')
    expect(preset.preset).toEqual(JSON.parse(json))
    expect(preset.preset.prompts).toHaveLength(209)
    const result = composeTavernMessages(preset, [{ role: 'user', content: '继续写作' }])
    expect(result.variables['字数']).toContain('800-1000')
    expect(result.variables['速度']).toContain('慢速')
    expect(result.messages.some(m => m.role === 'user' && m.content === '继续写作')).toBe(true)
    expect(result.messages.map(m => m.content).join('\n')).not.toMatch(/\{\{(?:setvar|getvar|\/\/)/i)
    expect(result.warnings.filter(w => w.startsWith('Unresolved macro'))).toEqual(['Unresolved macro / 未解析宏: {{count_total}}'])
    preset.macros.count_total = '1'
    expect(composeTavernMessages(preset, []).warnings.filter(w => w.startsWith('Unresolved macro'))).toEqual([])
  })
  it('supports nested multiline assignments, Chinese names, empty initialization and literal values', () => {
    const render = createTavernMacroRenderer({ macros: { user: 'Alice' } })
    expect(render.render('{{setvar::文风::}}x{{setvar::文风::第一行\n{{User}}::第二行}}{{getvar::文风}}')).toBe('x第一行\nAlice::第二行')
    expect(render.render('{{setvar::a::safe}}{{setvar::b::{{getvar::a}}}}[{{getvar::b}}]')).toBe('[safe]')
    const literal = createTavernMacroRenderer({ variables: { x: '$& {{setvar::a::bad}}' } })
    expect(literal.render('{{getvar::x}}')).toBe('$& {{setvar::a::bad}}')
    expect(literal.variables.has('a')).toBe(false)
  })
  it('uses explicit overrides even after preset resets, isolates scopes and requests', () => {
    const render = createTavernMacroRenderer({ variables: { 字数: '2000' }, globalVariables: { x: 'global' } })
    expect(render.render('{{setvar::字数::}}{{setvar::字数::800}}{{getvar::字数}}')).toBe('2000')
    expect(render.render('{{setvar::x::local}}{{getvar::x}}/{{getglobalvar::x}}')).toBe('local/global')
    expect(createTavernMacroRenderer().render('{{getvar::x}}{{getglobalvar::x}}')).toBe('')
    expect(render.render('{{setvar::n::1}}{{addvar::n::2}}{{incvar::n}}/{{decvar::n}}')).toBe('4/3')
  })
  it('removes comments without evaluating them and preserves unsupported macros', () => {
    const renderer = createTavernMacroRenderer()
    expect(renderer.render('a\n{{trim}}\nb{{// {{setvar::x::bad}} }}{{unknown::x}}')).toBe('ab{{unknown::x}}')
    expect(renderer.variables.has('x')).toBe(false)
    expect([...renderer.warnings]).toEqual(['{{unknown::x}}'])
    expect(renderer.render('{{unclosed')).toBe('{{unclosed')
  })
  it('supports legacy random, nested choices, dice, stable pick and time formats', () => {
    const renderer = createTavernMacroRenderer({ random: () => 0.5, now: new Date(2026, 10, 7, 13, 5, 9), uuid: () => 'uuid', macros: { user: 'A::B' } })
    expect(renderer.render('{{random::first::{{user}}}}')).toBe('A::B')
    expect(renderer.render('{{random:a,b}}/{{roll:2d6+1}}/{{timestamp:YYYYMMDDHHmmss}}/{{uuid}}')).toBe('b/9/20261107130509/uuid')
    expect(renderer.render('{{pick::a::b}}')).toBe(renderer.render('{{pick::a::b}}'))
  })
  it('discovers variables inside nested multiline values and ignores comments', () => {
    expect(discoverTavernVariables(['{{setvar::视角::{{User}}\n{{getglobalvar::世界}}}}{{// {{getvar::忽略}} }}{{getvar 字数}}'])).toEqual({ variables: ['视角', '字数'], globalVariables: ['世界'], macros: ['user'] })
  })
  it('uses prompt_order switches, history placement, roles and depth ordering', () => {
    const preset = entry([
      { identifier: 'main', content: '{{setvar::x::head}}before', role: 'system' },
      { identifier: 'disabled', content: '{{setvar::x::wrong}}' },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'tail', content: '{{getvar::x}} after {{input}}', role: 'assistant' },
      { identifier: 'depth', content: 'depth', role: 'user', injection_position: 1, injection_depth: 1 },
      { identifier: 'end', content: 'end', role: 'system', injection_position: 1, injection_depth: 0 },
    ])
    preset.preset.prompt_order[0].order[1].enabled = false
    preset.preset.prompts.push({ identifier: 'unlisted', content: 'unlisted' })
    const original: TavernMessage[] = [{ role: 'system', content: 'JSON contract' }, { role: 'assistant', content: 'old' }, { role: 'user', content: '{{getvar::private}}' }]
    const result = composeTavernMessages(preset, original)
    expect(result.messages.map(m => m.content)).toEqual(['JSON contract', 'before', 'old', 'depth', '{{getvar::private}}', 'end', 'head after {{getvar::private}}'])
    expect(result.messages.at(-1)?.role).toBe('assistant')
    expect(original).toHaveLength(3)
  })
  it('preserves task messages without an enabled history marker and maps configured markers', () => {
    const preset = entry([{ identifier: 'charDescription', marker: true }, { identifier: 'chatHistory', marker: true }])
    preset.preset.prompt_order[0].order[1].enabled = false
    preset.macros.description = 'Character description'
    expect(composeTavernMessages(preset, [{ role: 'user', content: 'task' }]).messages.map(m => m.content)).toEqual(['Character description', 'task'])
  })
  it('rejects malformed imports, duplicate identities and invalid persisted selections', () => {
    expect(() => parseTavernPreset({ prompts: 'wrong' })).toThrow()
    expect(() => entry([{ identifier: 'x' }, { identifier: 'x' }])).toThrow()
    expect(() => entry([{ identifier: 'x', injection_depth: -1 }])).toThrow()
    expect(() => parseTavernSettings({ presets: [], activePresetId: 'missing', scope: 'text' })).toThrow()
    const safe = entry([{ identifier: 'x', content: '{{getvar::__proto__}}' }])
    safe.variables = JSON.parse('{"__proto__":"literal"}')
    expect(composeTavernMessages(safe, []).messages[0].content).toBe('literal')
  })
  it('bounds expansion and never executes recursively inserted variable values', () => {
    const renderer = createTavernMacroRenderer()
    expect(() => renderer.render('{{setvar::x::'.repeat(40) + 'a' + '}}'.repeat(40))).toThrow('SILLYTAVERN_MACRO_LIMIT')
  })
})
