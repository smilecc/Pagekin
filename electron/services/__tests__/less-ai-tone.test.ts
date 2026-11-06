import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectLessAiTone, reportLessAiTone } from '../less-ai-tone'
import { LESS_AI_TONE_REVISION } from '../../../src/shared/less-ai-tone'

describe('pinned upstream Python workflow', () => {
  const root = path.resolve('public/less-ai-tone')
  const original = '核心是：这不是技术问题，而是认知问题。\n\n林岚走进旧城，沿着熟悉的街道继续向前，终于在拐角处看见了那座久违的小楼。\n\n'.repeat(12)
  it('executes the original detector, extracts candidates and runs the original report', async () => {
    const detected = await detectLessAiTone(root, original)
    expect(detected.rules.revision).toBe(LESS_AI_TONE_REVISION)
    expect(detected.rules.skill).toContain('收到用户回复前不得改写文章')
    expect(detected.candidates.colon.length).toBeGreaterThan(0)
    expect(detected.metrics).toHaveProperty('hits')
    const retest = await reportLessAiTone(root, { before: original, after: original.replace('这不是技术问题，而是认知问题', '这是认知问题'), semantic: detected.candidates })
    expect(retest.report).toContain('前后对比报告')
    expect(retest.report).toContain('核心是')
    expect(retest.after.metrics).not.toEqual(detected.metrics)
  }, 30_000)
  it('rejects empty input before launching Python', async () => {
    await expect(detectLessAiTone(root, '')).rejects.toThrow('TONE_TEXT_INVALID')
  })
  it('preserves the upstream minimum instead of fabricating a short-text result', async () => {
    await expect(detectLessAiTone(root, '短文。')).rejects.toThrow('TONE_TOO_SHORT')
  })
})
