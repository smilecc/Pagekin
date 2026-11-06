import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { MainGenerationRunHandle } from './generation/generation-runtime'
import { labelToneCandidates, parseToneJson, reviewToneFindings, toneFindings, SEMANTIC_LABELS, TONE_SEMANTIC_BATCH, TONE_REVIEW_BATCH, type ToneFinding, type SemanticKind, type ToneDetection, type ToneRules, type ToneCandidates } from '../shared/less-ai-tone'

export interface ToneRun {
  version: 1
  source: string
  style: string
  modelId: string
  nonce: string
  handle?: MainGenerationRunHandle
  detection?: ToneDetection
  rules?: ToneRules
  semantic?: ToneCandidates
  findings?: ToneFinding[]
  report?: string
  approved?: string
  revised?: string
  changes?: unknown[]
  comparison?: string
  after?: ToneDetection
  verification?: string
  outputs: Record<string, string>
  nonces: Record<string, string>
  failures?: { key: string; output: string; error: string }[]
}
export const newToneRun = (source: string, style: string, modelId: string): ToneRun => ({
  version: 1, source, style, modelId, nonce: crypto.randomUUID(), outputs: {}, nonces: {},
})

/** A single main-owned budget spans classification, report, rewrite and recheck. */
export function createToneWorkflow(session: ProjectSessionContext, run: ToneRun, save: (run: ToneRun) => void, progress: (step: string) => void) {
  let stopped = false
  const checkpoint = () => { if (stopped) throw new Error('TONE_CANCELLED'); save(structuredClone(run)) }
  const generate = async (key: string, system: string, input: string, structured = false) => {
    if (stopped) throw new Error('TONE_CANCELLED')
    if (run.outputs[key] !== undefined) return run.outputs[key]
    if (!run.handle) {
      const view = await ipc.invokeWithProjectSession(session, 'generation:begin', {
        operation: 'less-ai-tone', uiActionNonce: run.nonce, modelId: run.modelId,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['less_ai_tone'], skillStages: [],
        authorInputs: [{ id: 'source', text: run.source }, { id: 'style', text: run.style }, { id: 'upstream', text: JSON.stringify(run.rules) }, { id: 'detection', text: JSON.stringify(run.detection) }],
        output: 'visible-text', outputOverrides: [{ purpose: 'tone-labels', output: 'structured-data' }, { purpose: 'tone-rewrite', output: 'structured-data' }],
      })
      run.handle = view.handle
      if (stopped) { await ipc.invokeWithProjectSession(session, 'generation:cancel', view.handle); throw new Error('TONE_CANCELLED') }
      checkpoint()
    }
    const view = await ipc.invokeWithProjectSession(session, 'generation:read', run.handle)
    if (view.status === 'cancelled') throw new Error('TONE_CANCELLED')
    if (view.nonReplayable) run.handle = (await ipc.invokeWithProjectSession(session, 'generation:resume', run.handle)).handle
    const invocationNonce = run.nonces[key] ??= crypto.randomUUID()
    checkpoint()
    const receipt = await ipc.invokeWithProjectSession(session, 'generation:execute', {
      handle: run.handle, invocationNonce,
      task: { purpose: structured ? key.startsWith('rewrite') ? 'tone-rewrite' : 'tone-labels' : 'tone-report',
        output: structured ? 'structured-data' : 'visible-text', reasoningStage: 'review',
        messages: [{ role: 'system', content: system }, { role: 'user', content: input }] },
    })
    run.handle = receipt.run.handle
    if (receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop') {
      delete run.nonces[key]; checkpoint(); throw new Error(receipt.outcome.receipt.failureCode || 'TONE_GENERATION_INCOMPLETE')
    }
    run.outputs[key] = receipt.outcome.content
    checkpoint()
    return receipt.outcome.content
  }
  async function generateValidated<T>(key: string, system: string, input: string, decode: (output: string) => T): Promise<T> {
    const keys = [key, `${key}:format-retry:1`]
    for (const [attempt, attemptKey] of keys.entries()) {
      const instruction = attempt === 0 ? system : `${system}\n上一次输出未通过 JSON 或逐项合同校验。本次从输入证据重新独立生成完整结果，不引用上次答案，不输出工具调用或 DSML 标签。只输出一个 JSON 对象，严格满足字段类型、必填值、条目数量和唯一索引/ID要求。`
      const output = await generate(attemptKey, instruction, input, true)
      try { return decode(output) }
      catch (error) {
        run.failures = [...(run.failures ?? []), { key: attemptKey, output, error: error instanceof Error ? error.message : 'TONE_JSON_INVALID' }].slice(-8)
        checkpoint()
      }
    }
    // A later explicit retry gets new invocations, but never loses the diagnostic evidence.
    for (const attemptKey of keys) { delete run.outputs[attemptKey]; delete run.nonces[attemptKey] }
    checkpoint()
    throw new Error('TONE_STRUCTURED_OUTPUT_INVALID')
  }
  async function label() {
    const labeled = structuredClone(run.detection!.candidates)
    for (const kind of Object.keys(SEMANTIC_LABELS) as SemanticKind[]) {
      const candidates = labeled[kind]
      for (let start = 0; start < candidates.length; start += TONE_SEMANTIC_BATCH) {
        const key = `labels-${kind}-${start}`
        progress('semantic')
        const batch = candidates.slice(start, start + TONE_SEMANTIC_BATCH)
        const rows = await generateValidated(key, `${run.rules!.criteria}\n只执行语义判读，不改写。逐条独立判断，不推断全文来源。只返回一个 JSON 对象 {"items":[{"index":0,"label":"合法标签","confidence":"高","reason":"判读理由"}]}。items 必须覆盖本批所有条目且只覆盖一次，index 是本批次从 0 开始的索引，confidence 只能为高、中、低。禁止缺值、重复索引、额外对象、工具调用及 DSML 标签。`, JSON.stringify({ kind, labels: SEMANTIC_LABELS[kind], candidates: batch }), output => labelToneCandidates(kind, batch, output))
        labeled[kind].splice(start, batch.length, ...rows)
      }
    }
    run.semantic = labeled; checkpoint()
  }
  const rules = () => `${run.rules!.skill}\n\n${run.rules!.detect}\n\n${run.rules!.criteria}`
  async function reviewFindings() {
    const findings = toneFindings(run.source, run.detection!, run.semantic!)
    for (let start = 0; start < findings.length; start += TONE_REVIEW_BATCH) {
      const key = `findings-${start}`, batch = findings.slice(start, start + TONE_REVIEW_BATCH)
      const rows = await generateValidated(key, `${rules()}\n执行第二步的逐条命中复核。只返回一个 JSON 对象 {"items":[{"id":"输入id","decision":"拟改","reason":"逐处理由","suggestion":"具体改法"}]}。decision 只允许拟改、保留、误报、待核/人审。每个输入 id 必须出现一次，阴性也记录。拟改提供具体改法，其他项目解释逐处理由。所有字段都是字符串，保留项的 suggestion 可为空字符串。不要修改原文。不输出工具调用或 DSML 标签。`, JSON.stringify({ original: run.source, styleReference: run.style, findings: batch }), output => reviewToneFindings(batch, output))
      findings.splice(start, batch.length, ...rows)
    }
    run.findings = findings; checkpoint()
  }
  return {
    async inspect() {
      progress('detect')
      if (!run.detection) {
        const { rules: upstream, ...detection } = await ipc.invokeWithProjectSession(session, 'generation:tone-detect', run.source)
        run.rules = upstream; run.detection = detection; checkpoint()
      }
      if (!run.semantic) await label()
      progress('report')
      if (!run.findings) await reviewFindings()
      run.report = await generate('report', `${rules()}\n现在执行第二步，只交付完整、可读的改前报告，不交付改后全文。原始候选完整保存在应用中，报告须解释命中去向和典型例句。按判据汇总语义指标，注明抽样覆盖和不足，不伪造单篇显著性。`, JSON.stringify({ original: run.source, styleReference: run.style, detection: run.detection, semantic: run.semantic, findings: run.findings }))
      checkpoint()
    },
    async rewrite(approval: string) {
      if (!run.report || !run.semantic || !run.rules) throw new Error('TONE_REPORT_REQUIRED')
      run.approved ??= approval.trim() || '按建议改'
      checkpoint(); progress('rewrite')
      if (run.revised === undefined) {
        const result = await generateValidated('rewrite', `${rules()}\n用户已经确认第二步方案。现在执行第三步，按上游规则及用户调整改写并完成三项自查。仅返回 JSON 对象 {"text":"改后全文","changes":[{"before":"原文","after":"改后","rule":"方案项及规则编号"}]}，即使无须修改也返回完整原文。不输出工具调用或 DSML 标签。`, JSON.stringify({ original: run.source, styleReference: run.style, report: run.report, semantic: run.semantic, findings: run.findings, approval: run.approved }), output => {
          const parsed = parseToneJson(output) as { text: string; changes: unknown[] }
          if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim() || !Array.isArray(parsed.changes)) throw new Error('TONE_REWRITE_INVALID')
          return parsed
        })
        run.revised = result.text; run.changes = result.changes; checkpoint()
      }
      progress('retest')
      if (!run.comparison) {
        const result = await ipc.invokeWithProjectSession(session, 'generation:tone-report', { before: run.source, after: run.revised, semantic: run.semantic })
        run.comparison = result.report; run.after = result.after; checkpoint()
      }
      progress('verify')
      run.verification = await generate('verification', `${rules()}\n现在执行第四步复测判读与改后三查。核对每处修改对应方案和规则、信息出处、拟改项完成情况以及保留项理由。给出结论和未解决项；不输出另一份改稿。不把改前语义标签当成改后实测，不为指标达标而追加修改。`, JSON.stringify({ original: run.source, revised: run.revised, approval: run.approved, report: run.report, changes: run.changes, before: run.detection, after: run.after, originalSemantic: run.semantic, styleReference: run.style }))
      checkpoint()
    },
    async cancel() {
      stopped = true
      if (run.handle) await ipc.invokeWithProjectSession(session, 'generation:cancel', run.handle)
    },
  }
}
