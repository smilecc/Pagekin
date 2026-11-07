import { describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { AIRequestLog, LoggedLLMProvider } from '../request-log'
import type { ILLMProvider, LLMStreamOptions } from '../provider.interface'

const model: ModelProfile = {
  id: 'test', name: 'Test model', modelName: 'test-model', protocol: 'openai', provider: 'openai',
  apiKey: 'secret-key', baseUrl: 'https://example.com', temperature: 0.7, maxTokens: 100, purposes: ['generation'],
}
const messages = [{ role: 'system', content: '系统提示词' }, { role: 'user', content: '用户提示词' }]
const options = { temperature: 0.7, maxTokens: 100 }
const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 }

function setup(stream: ILLMProvider['generateStream']) {
  const log = new AIRequestLog()
  const provider = new LoggedLLMProvider({
    generate: vi.fn(async () => ({ success: true as const, content: '回答', finishReason: 'stop' as const, usage })),
    generateStream: stream,
  }, log)
  return { log, provider }
}

const callbacks = (controller = new AbortController()): LLMStreamOptions => ({
  ...options, signal: controller.signal, onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
})

describe('AI request diagnostics', () => {
  it('keeps the latest 50 requests, snapshots messages, and excludes credentials and full text from summaries', () => {
    const log = new AIRequestLog()
    const input = messages.map(message => ({ ...message }))
    const first = log.start(model, input, options, false)
    input[0].content = 'changed'
    expect(log.get(first)?.messages).toEqual(messages)
    for (let i = 0; i < 50; i++) log.start({ ...model, name: String(i) }, messages, options, false)
    expect(log.get(first)).toBeNull()
    log.append(first, 'late chunk')
    log.finish(first, 'stop')
    expect(log.list()).toHaveLength(50)
    expect(log.list()[0].modelName).toBe('49')
    expect(log.list()[0]).not.toHaveProperty('messages')
    expect(log.list()[0]).not.toHaveProperty('response')
    expect(JSON.stringify(log.get(log.list()[0].id))).not.toContain('secret-key')
  })

  it('records non-stream output and usage without changing the result', async () => {
    const { log, provider } = setup(vi.fn())
    const result = await provider.generate(model, messages, options)
    expect(result).toMatchObject({ success: true, content: '回答', usage })
    expect(log.get(log.list()[0].id)).toMatchObject({ status: 'succeeded', messages, response: '回答', usage, streaming: false })
  })

  it('exposes partial streaming text before completion and forwards callbacks unchanged', async () => {
    const opts = callbacks()
    const { log, provider } = setup(async (_model, _messages, stream) => {
      stream.onChunk('第一段')
      expect(log.get(log.list()[0].id)).toMatchObject({ status: 'running', response: '第一段' })
      stream.onChunk('第二段')
      stream.onDone('第一段第二段', usage, 'stop')
    })
    await provider.generateStream(model, messages, opts)
    expect(opts.onChunk).toHaveBeenCalledTimes(2)
    expect(opts.onDone).toHaveBeenCalledWith('第一段第二段', usage, 'stop')
    expect(log.get(log.list()[0].id)).toMatchObject({ status: 'succeeded', response: '第一段第二段', usage })
  })

  it('keeps incomplete output on errors, and does not invent usage', async () => {
    const { log, provider } = setup(async (_model, _messages, stream) => {
      stream.onChunk('partial')
      stream.onError('network failed')
    })
    await provider.generateStream(model, messages, callbacks())
    expect(log.get(log.list()[0].id)).toMatchObject({ status: 'failed', response: 'partial', error: 'network failed' })
    expect(log.list()[0].usage).toBeUndefined()
  })

  it('settles cancellation immediately and accepts transport usage afterward', async () => {
    const controller = new AbortController()
    const { log, provider } = setup(async (_model, _messages, stream) => {
      stream.onChunk('partial')
      controller.abort()
      expect(log.list()[0].status).toBe('cancelled')
      stream.onError('cancelled', 'partial', usage)
    })
    await provider.generateStream(model, messages, callbacks(controller))
    expect(log.get(log.list()[0].id)).toMatchObject({ status: 'cancelled', response: 'partial', usage })
  })

  it('keeps concurrent requests separate and preserves non-stop terminal evidence', async () => {
    const { log, provider } = setup(async (_model, input, stream) => {
      await Promise.resolve()
      stream.onChunk(input[0].content)
      stream.onDone(input[0].content, undefined, 'length')
    })
    await Promise.all(['one', 'two'].map(content => provider.generateStream(model, [{ role: 'user', content }], callbacks())))
    expect(log.list().map(record => log.get(record.id)?.response)).toEqual(['two', 'one'])
    expect(log.list().every(record => record.status === 'incomplete' && record.finishReason === 'length')).toBe(true)
  })

  it('records thrown failures, rethrows the original error, and handles missing terminal callbacks', async () => {
    const failure = new Error('transport broke')
    const { log, provider } = setup(async () => { throw failure })
    await expect(provider.generateStream(model, messages, callbacks())).rejects.toBe(failure)
    expect(log.list()[0]).toMatchObject({ status: 'failed', error: 'Error: transport broke' })
    const missing = setup(async () => {})
    await missing.provider.generateStream(model, messages, callbacks())
    expect(missing.log.list()[0]).toMatchObject({ status: 'incomplete', finishReason: 'unknown' })
  })
})
