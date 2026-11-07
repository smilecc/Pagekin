import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importTavernPreset, parseTavernPreset, parseTavernSettings, type TavernPrompt } from '../sillytavern-preset'
import { createTavernMacroRenderer, discoverTavernVariables } from '../sillytavern-macros'
import { composeTavernMessages, type TavernMessage } from '../sillytavern-compose'

function entry(prompts: TavernPrompt[]) {
  return importTavernPreset(JSON.stringify({ prompts, prompt_order: [{ character_id: 100001,
    order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] }), 'test.json', 'test')
}
describe('SillyTavern preset import and rendering', () => {
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
