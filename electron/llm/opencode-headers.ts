import { version as appVersion } from '../../package.json'

/** Keep routing affinity scoped to the caller's conversation, across protocols. */
export function opencodeHeaders(baseUrl: string, conversationId?: string): Record<string, string> {
  try {
    const endpoint = new URL(baseUrl.trim())
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'opencode.ai') return {}
  } catch {
    return {}
  }

  return {
    // One-off operations without a conversation must not share a global session.
    'x-opencode-session': conversationId || crypto.randomUUID(),
    'User-Agent': `ai-novel-writer/${appVersion}`,
  }
}
