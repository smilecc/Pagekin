import type { LLMFinishReason, TokenUsage } from './ipc-channels'

export interface AIRequestSummary {
  id: string
  startedAt: number
  durationMs: number
  modelName: string
  modelId: string
  protocol: string
  streaming: boolean
  status: 'running' | 'succeeded' | 'incomplete' | 'cancelled' | 'failed'
  usage?: TokenUsage
  finishReason?: LLMFinishReason
  error?: string
  revision: number
}

export interface AIRequestRecord extends AIRequestSummary {
  messages: Array<{ role: string; content: string }>
  response: string
  parameters: {
    temperature?: number
    maxTokens: number
    responseFormat?: { type: string }
  }
}
