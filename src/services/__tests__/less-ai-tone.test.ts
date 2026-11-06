import { beforeEach, expect, it, vi } from 'vitest'
import { createToneWorkflow, newToneRun, type ToneRun } from '../less-ai-tone'
import { ipc } from '../ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { GenerationTask } from '../generation/generation-harness'
import type { ToneCandidates } from '../../shared/less-ai-tone'

vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: vi.fn() } }))
const session: ProjectSessionContext = { projectId: 'p', projectPath: 'p', leaseId: 'lease' }
const handle = { projectId: 'p', epoch: 'e', rootActionId: 'root', runId: 'run' }
const metrics = { hits: { 翻案腔: [{ line: 1, excerpt: '不是甲，而是乙' }] }, syn_hits: [] }
const candidates = { meta: {}, rename: [{ para: '候选原文', line: 1 }], cohesion: [], colon: [], iso3: [] }
type Request = { task?: GenerationTask; semantic?: ToneCandidates }
let calls: { channel: string; request: Request }[]
let failRewrite = false
let explainJson = false
let invalidLabels = 0
beforeEach(() => {
  calls = []; failRewrite = false; explainJson = false; invalidLabels = 0
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: unknown, channel: string, request: Request) => {
    calls.push({ channel, request })
    if (channel === 'generation:tone-detect') return { metrics, candidates, rules: { revision: 'pinned', skill: '上游规则', criteria: '封闭判据', detect: '检测解释' } }
    if (channel === 'generation:begin' || channel === 'generation:read') return { handle, nonReplayable: false, status: 'running' }
    if (channel === 'generation:tone-report') return { report: '脚本对比报告', after: { metrics, candidates } }
    if (channel === 'generation:execute') {
      const task = request.task!, input = JSON.parse(task.messages[1].content) as { findings?: { id: string }[]; candidates: unknown[]; revised?: string }
      if (task.purpose === 'tone-labels' && !input.findings && invalidLabels > 0) {
        invalidLabels -= 1
        return { run: { handle }, outcome: { status: 'completed', finishReason: 'stop', content: '[{"index":0,"label":"0组","confidence":,"reason":"x"}]' } }
      }
      if (task.purpose === 'tone-rewrite' && failRewrite) throw new Error('network failed')
      const content = task.purpose === 'tone-labels'
        ? JSON.stringify(input.findings ? input.findings.map(row => ({ id: row.id, decision: '拟改', reason: '逐处理由', suggestion: '直接说明' })) : input.candidates.map((_row: unknown, index: number) => ({ index, label: '0组', confidence: '高', reason: '没有换称' })))
        : task.purpose === 'tone-rewrite' ? JSON.stringify({ text: '乙。', changes: [{ before: '不是甲，而是乙', after: '乙', rule: '1' }] })
          : input.revised ? '复核完成' : '建议修改第一句。'
      return { run: { handle }, outcome: { status: 'completed', finishReason: 'stop', content: explainJson && task.output === 'structured-data' ? `${content}\n\n以上为处理结果。` : content } }
    }
    return { handle }
  }) as typeof ipc.invokeWithProjectSession)
})
it('automatically regenerates a malformed batch once and preserves the failed evidence', async () => {
  invalidLabels = 1
  let saved = newToneRun('不是甲，而是乙。', '', 'model')
  await createToneWorkflow(session, saved, next => { saved = next }, () => {}).inspect()
  expect(saved.report).toBeTruthy()
  expect(saved.failures).toHaveLength(1)
  const attempts = calls.filter(call => call.channel === 'generation:execute' && call.request.task?.purpose === 'tone-labels' && call.request.task.messages[1].content.includes('"candidates"'))
  expect(attempts).toHaveLength(2)
  expect(attempts[1].request.task?.messages[0].content).toContain('从输入证据重新独立生成')
  expect(calls.filter(call => call.channel === 'generation:tone-detect')).toHaveLength(1)
})
it('stops after a failed regeneration and permits explicit retry without repeating completed work', async () => {
  invalidLabels = 2
  let saved = newToneRun('不是甲，而是乙。', '', 'model')
  const persist = (next: ToneRun) => { saved = next }
  await expect(createToneWorkflow(session, saved, persist, () => {}).inspect()).rejects.toThrow('TONE_STRUCTURED_OUTPUT_INVALID')
  expect(saved.report).toBeUndefined()
  expect(saved.failures).toHaveLength(2)
  expect(saved.outputs['labels-rename-0']).toBeUndefined()
  await createToneWorkflow(session, saved, persist, () => {}).inspect()
  expect(saved.report).toBeTruthy()
  expect(calls.filter(call => call.channel === 'generation:tone-detect')).toHaveLength(1)
  expect(calls.filter(call => call.channel === 'generation:begin')).toHaveLength(1)
})
it('completes classification, findings and rewrite when structured responses include trailing explanation', async () => {
  explainJson = true
  let saved = newToneRun('不是甲，而是乙。', '', 'model')
  const persist = (next: ToneRun) => { saved = next }
  await createToneWorkflow(session, saved, persist, () => {}).inspect()
  expect(saved.findings).toHaveLength(2)
  await createToneWorkflow(session, saved, persist, () => {}).rewrite('按建议改')
  expect(saved.revised).toBe('乙。')
  expect(saved.verification).toBe('复核完成')
})
it('stops at the report, then rewrites only after confirmation and uses original scripts for the retest', async () => {
  let saved = newToneRun('不是甲，而是乙。', '', 'model')
  const persist = (next: ToneRun) => { saved = next }
  await createToneWorkflow(session, saved, persist, () => {}).inspect()
  expect(saved.report).toBe('建议修改第一句。')
  expect(saved.semantic?.rename[0]).toMatchObject({ para: '候选原文', label: '0组' })
  expect(saved.findings).toHaveLength(2)
  expect(calls.some(call => call.request?.task?.purpose === 'tone-rewrite')).toBe(false)
  expect(calls.filter(call => call.channel === 'generation:begin')).toHaveLength(1)
  await createToneWorkflow(session, saved, persist, () => {}).rewrite('按建议改，仍按上游规则')
  expect(saved.revised).toBe('乙。')
  expect(saved.verification).toBe('复核完成')
  expect(calls.find(call => call.channel === 'generation:tone-report')?.request.semantic).toEqual(saved.semantic)
  expect(calls.filter(call => call.channel === 'generation:begin')).toHaveLength(1)
})
it('refuses rewriting before a report and recovers a failed rewrite without repeating detection', async () => {
  let saved = newToneRun('不是甲，而是乙。', '', 'model')
  const persist = (next: ToneRun) => { saved = next }
  await expect(createToneWorkflow(session, saved, persist, () => {}).rewrite('按建议改')).rejects.toThrow('TONE_REPORT_REQUIRED')
  await createToneWorkflow(session, saved, persist, () => {}).inspect()
  failRewrite = true
  await expect(createToneWorkflow(session, saved, persist, () => {}).rewrite('按建议改')).rejects.toThrow('network failed')
  expect(saved.approved).toBe('按建议改')
  const firstNonce = saved.nonces.rewrite
  failRewrite = false
  await createToneWorkflow(session, saved, persist, () => {}).rewrite('新的文字不会改掉已冻结的确认')
  expect(saved.nonces.rewrite).toBe(firstNonce)
  expect(calls.filter(call => call.channel === 'generation:tone-detect')).toHaveLength(1)
  expect(saved.approved).toBe('按建议改')
})
