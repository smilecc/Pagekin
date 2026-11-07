import { randomUUID } from 'node:crypto'
import type { AIRequestRecord, AIRequestSummary } from '../../src/shared/ai-request-log'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import type { ILLMProvider, LLMGenerateOptions, LLMStreamOptions } from './provider.interface'
import { VisibleStreamFilter } from './visible-stream'

/** App-session diagnostics only: bounded, never persisted with manuscripts or API keys. */
export class AIRequestLog {
  private records: AIRequestRecord[] = []

  start(model: ModelProfile, messages: AIRequestRecord['messages'], opts: LLMGenerateOptions, streaming: boolean): string {
    const id = randomUUID()
    this.records.unshift({
      id, startedAt: Date.now(), durationMs: 0, modelId: model.modelName,
      modelName: model.name || model.modelName, protocol: model.protocol, streaming,
      status: 'running', revision: 0, messages: messages.map(message => ({ ...message })), response: '',
      parameters: { temperature: opts.temperature, maxTokens: opts.maxTokens,
        ...(opts.responseFormat ? { responseFormat: { ...opts.responseFormat } } : {}) },
    })
    this.records.length = Math.min(this.records.length, 50)
    return id
  }

  append(id: string, chunk: string): void {
    const record = this.records.find(record => record.id === id)
    if (!record || record.status !== 'running' || !chunk) return
    record.response += chunk
    record.revision++
  }

  usage(id: string, usage: TokenUsage): void {
    const record = this.records.find(record => record.id === id)
    if (!record) return
    record.usage = { ...usage }
    record.revision++
  }

  finish(id: string, reason: LLMFinishReason, response?: string, usage?: TokenUsage, error?: string): void {
    const record = this.records.find(record => record.id === id)
    if (!record || (record.status !== 'running' && record.status !== 'cancelled')) return
    // Abort settles immediately; the transport may still supply final usage/partial text.
    if (record.status === 'cancelled') {
      if (response !== undefined) record.response = response
      if (usage) record.usage = { ...usage }
      if (error) record.error = error
      record.revision++
      return
    }
    record.finishReason = reason
    record.status = reason === 'stop' ? 'succeeded' : reason === 'cancelled' ? 'cancelled'
      : reason === 'error' ? 'failed' : 'incomplete'
    record.durationMs = Math.max(0, Date.now() - record.startedAt)
    if (response !== undefined) record.response = response
    if (usage) record.usage = { ...usage }
    if (error) record.error = error
    record.revision++
  }

  list(): AIRequestSummary[] {
    return this.records.map(record => ({
      id: record.id, startedAt: record.startedAt, modelId: record.modelId, modelName: record.modelName,
      protocol: record.protocol, streaming: record.streaming, status: record.status, revision: record.revision,
      finishReason: record.finishReason, error: record.error, usage: record.usage ? { ...record.usage } : undefined,
      durationMs: record.status === 'running' ? Math.max(0, Date.now() - record.startedAt) : record.durationMs,
    }))
  }

  get(id: string): AIRequestRecord | null {
    const record = this.records.find(record => record.id === id)
    return record ? structuredClone(record) : null
  }
}

export const aiRequestLog = new AIRequestLog()

/** Observe the common provider seam, including main-owner workflows and connection tests. */
export class LoggedLLMProvider implements ILLMProvider {
  constructor(private readonly provider: ILLMProvider, private readonly log = aiRequestLog) {}

  async generate(model: ModelProfile, messages: AIRequestRecord['messages'], opts: LLMGenerateOptions) {
    const id = this.log.start(model, messages, opts, false)
    try {
      const result = await this.provider.generate(model, messages, opts)
      this.log.finish(id, opts.signal?.aborted ? 'cancelled' : result.finishReason, result.content, result.usage, result.error)
      return result
    } catch (error) {
      this.log.finish(id, opts.signal?.aborted ? 'cancelled' : 'error', undefined, undefined, String(error))
      throw error
    }
  }

  async generateStream(model: ModelProfile, messages: AIRequestRecord['messages'], opts: LLMStreamOptions) {
    const id = this.log.start(model, messages, opts, true)
    const visible = new VisibleStreamFilter()
    const cancelled = () => this.log.finish(id, 'cancelled')
    opts.signal.addEventListener('abort', cancelled, { once: true })
    if (opts.signal.aborted) cancelled()
    try {
      await this.provider.generateStream(model, messages, {
        ...opts,
        onChunk: chunk => {
          this.log.append(id, visible.push(chunk))
          opts.onChunk(chunk)
        },
        onUsageEvidence: evidence => {
          this.log.usage(id, evidence.usage)
          opts.onUsageEvidence?.(evidence)
        },
        onDone: (content, usage, reason) => {
          this.log.finish(id, reason, content, usage)
          opts.onDone(content, usage, reason)
        },
        onError: (error, content, usage) => {
          this.log.finish(id, opts.signal.aborted ? 'cancelled' : 'error', content, usage, error)
          opts.onError(error, content, usage)
        },
      })
      // A provider returning without a terminal callback is not a successful completion.
      this.log.finish(id, opts.signal.aborted ? 'cancelled' : 'unknown')
    } catch (error) {
      this.log.finish(id, opts.signal.aborted ? 'cancelled' : 'error', undefined, undefined, String(error))
      throw error
    } finally {
      opts.signal.removeEventListener('abort', cancelled)
    }
  }
}
