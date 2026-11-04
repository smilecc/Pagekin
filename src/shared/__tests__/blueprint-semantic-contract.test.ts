import { describe, expect, it } from 'vitest'
import { decodeBlueprintSemanticPayload, parseBlueprintSemanticResponseText, blueprintSemanticGenerationContract } from '../blueprint-semantic-contract'
const plan = { chapterNumber: 1, title: '来信', keyEvents: '林岚收到来信，决定调查信件来源。\n她在码头发现新的线索。', characters: ['林岚'] }
describe('story planning contract', () => {
  it('accepts the chapter title and full planning prose without hidden fields', () => {
    expect(parseBlueprintSemanticResponseText(JSON.stringify({ blueprints: [plan] }), [1])).toEqual([plan])
  })
  it('does not propagate hidden metadata', () => {
    expect(decodeBlueprintSemanticPayload({ blueprints: [{ ...plan, role: '旧功能', relationships: [] }] }, [1])).toEqual([plan])
  })
  it.each(['title', 'keyEvents'])('rejects missing %s', field => {
    const value: Record<string, unknown> = { ...plan }; delete value[field]
    expect(() => decodeBlueprintSemanticPayload({ blueprints: [value] }, [1])).toThrow()
  })
  it.each(['title', 'keyEvents'])('rejects empty %s', field => {
    expect(() => decodeBlueprintSemanticPayload({ blueprints: [{ ...plan, [field]: '  ' }] }, [1])).toThrow()
  })
  it('requires exact chapter coverage', () => {
    expect(() => decodeBlueprintSemanticPayload({ blueprints: [plan] }, [1, 2])).toThrow()
    expect(() => decodeBlueprintSemanticPayload({ blueprints: [plan, plan] }, [1])).toThrow()
    expect(() => decodeBlueprintSemanticPayload({ blueprints: [plan] }, [2])).toThrow()
  })
  it('preserves explicit cast even when prose uses only pronouns and deduplicates names', () => {
    expect(decodeBlueprintSemanticPayload([{ ...plan, keyEvents: '她决定回去找师父。', characters: [' 林岚 ', '师父顾舟', '林岚'] }], [1])[0].characters).toEqual(['林岚', '师父顾舟'])
  })
  it.each([undefined, '林岚', [''], [123]])('rejects an invalid cast list: %j', characters => {
    expect(() => decodeBlueprintSemanticPayload([{ ...plan, characters }], [1])).toThrow()
  })
  it('accepts a chapter without characters', () => {
    expect(decodeBlueprintSemanticPayload([{ ...plan, characters: [] }], [1])[0].characters).toEqual([])
  })
  it('states the current wire contract', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('每项仅包含 chapterNumber、title、keyEvents、characters')
  })
})
