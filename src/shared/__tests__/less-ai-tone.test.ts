import { describe, expect, it } from 'vitest'
import { labelToneCandidates, parseToneJson, toneRequestBound } from '../less-ai-tone'
import { computeSegments } from '../../components/editor/merge-segments'

describe('model JSON envelopes', () => {
  const result = { text: '保留字面括号 [甲]、{乙}、引号 " 和反斜线 \\，以及 ```。', changes: [] }
  it.each([
    (json: string) => json,
    (json: string) => `${json}\n\n以上是修改结果。`,
    (json: string) => `以下是结果：\n\`\`\`json\n${json}\n\`\`\`\n说明：已处理完毕。`,
  ])('accepts one complete result without changing its strings', wrap => {
    for (const value of [result, [result]]) expect(parseToneJson(wrap(JSON.stringify(value, null, 2)))).toEqual(value)
  })
  it.each(['[]\n{}', '```json\n[]\n```\n```json\n[]\n```', '[{"index":0}', '[{"index":0},]', '{"text":"未结束', '没有 JSON'])('rejects ambiguous or incomplete output: %s', output => {
    expect(() => parseToneJson(output)).toThrow('TONE_JSON_INVALID')
  })
})

describe('upstream semantic records', () => {
  it('budgets all sampled semantic candidates and all raw findings before dispatch', () => {
    const candidates = { meta: {}, rename: Array(60).fill({}), cohesion: Array(60).fill({}), colon: Array(80).fill({}), iso3: Array(60).fill({}) }
    expect(toneRequestBound('“对白”'.repeat(100), { candidates, metrics: { hits: { rule: Array(200).fill({}) }, syn_hits: [] } })).toBe(102)
  })
  const input = [{ para: '原文不得被分类模型改写', line: 4 }, { para: '阴性也要记录', line: 6 }]
  it('retains all original fields and accepts negative and uncertain classifications', () => {
    const result = labelToneCandidates('rename', input, JSON.stringify([
      { index: 1, label: '无法判断', confidence: '低', reason: '上下文不足' },
      { index: 0, label: '0组', confidence: '高', reason: '没有换称', para: '伪造原文' },
    ]))
    expect(result[0]).toMatchObject({ ...input[0], label: '0组' })
    expect(result[1]).toMatchObject({ ...input[1], label: '无法判断' })
    expect(input[0]).not.toHaveProperty('label')
  })
  it.each([
    [],
    [{ index: 0, label: '0组', confidence: '高', reason: '一' }, { index: 0, label: '0组', confidence: '高', reason: '二' }],
    [{ index: 0, label: '自造标签', confidence: '高', reason: '一' }, { index: 1, label: '0组', confidence: '高', reason: '二' }],
  ].map(rows => [rows]))('rejects missing, duplicate or invented labels', rows => {
    expect(() => labelToneCandidates('rename', input, JSON.stringify(rows))).toThrow('TONE_LABELS_INVALID')
  })
  it('accepts the object envelope used by JSON-object providers and retains DSML-free payloads', () => {
    const items = input.map((_, index) => ({ index, label: '0组', confidence: '高', reason: '没有换称' }))
    expect(labelToneCandidates('rename', input, JSON.stringify({ items }) + '\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜calls>')).toHaveLength(2)
    expect(() => labelToneCandidates('rename', input, JSON.stringify({ items: [items[0], items[0]] }))).toThrow('TONE_LABELS_INVALID')
  })
})

describe('existing merge in exact-text mode', () => {
  it.each([
    ['---\r\ntitle: 原文\r\n---\r\n\r\n甲。\r\n\r\n\r\n乙。\r\n', '---\r\ntitle: 原文\r\n---\r\n\r\n甲改。\r\n\r\n\r\n乙。\r\n'],
    ['第一段。\n\n第二段。\n\n', '新增。\n\n第一段。\n\n第二段改。\n\n'],
    ['一。\n\n二。', '一。'],
    ['', '新增文本。\n'],
    ['\n\n原文😀\n\n', '\n\n原文😀\n\n'],
  ])('round-trips both sides including whitespace and frontmatter', (before, after) => {
    const segments = computeSegments(before, after, true)
    const collect = (side: 'originalLines' | 'modifiedLines') => segments.map(segment => (segment.type === 'same' ? segment.lines! : segment.hunk![side]).join('\n')).join('')
    expect(collect('originalLines')).toBe(before)
    expect(collect('modifiedLines')).toBe(after)
  })
})
