import { expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))
import { checkArchConfirmed } from '../architecture-service'
const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
it('只有空白（超过 50 个字符）与没有内容一样未确认', async () => {
  invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:project-core-get') return { worldbuilding: ' \n'.repeat(40) }
    return { status: 'ready' }
  })
  expect(await checkArchConfirmed(session)).toEqual({ characters: true, worldbuilding: false })
})
