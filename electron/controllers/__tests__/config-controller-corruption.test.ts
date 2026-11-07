import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importTavernPreset } from '../../../src/shared/sillytavern-preset'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

let fixtureRoot = ''
let velaHome = ''

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-corrupt-'))
  fixtureRoot = velaHome
    velaHome = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  const { registerConfigController } = await import('../config-controller')
  registerConfigController()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
    delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('global configuration corruption boundary', () => {
  it('persists imported presets and overrides, and rejects invalid updates without losing unrelated settings', async () => {
    const entry = importTavernPreset(JSON.stringify({ prompts: [{ identifier: 'main', content: '{{getvar::字数}}' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] }), 'test.json', 'id')
    entry.variables['字数'] = '2000'
    const sillyTavern = { presets: [entry], activePresetId: entry.id, scope: 'text' }
    await handler('config:set')({}, { theme: 'light' })
    await expect(handler('config:set')({}, { sillyTavern })).resolves.toEqual({ success: true })
    await expect(handler('config:get')()).resolves.toMatchObject({ theme: 'light', sillyTavern })
    const file = path.join(velaHome, 'config.json'), bytes = fs.readFileSync(file)
    await expect(handler('config:set')({}, { sillyTavern: { ...sillyTavern, activePresetId: 'missing' } })).resolves.toMatchObject({ success: false })
    expect(fs.readFileSync(file)).toEqual(bytes)
  })
  it('refuses to overwrite an existing malformed config file', async () => {
    const configPath = path.join(velaHome, 'config.json')
    const originalBytes = Buffer.from('{BROKEN_CONFIG_SECRET_MARKER', 'utf8')
    fs.writeFileSync(configPath, originalBytes)

    await expect(handler('config:set')({}, { theme: 'light' })).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    })
    expect(fs.readFileSync(configPath)).toEqual(originalBytes)
  })

  it('creates a missing config from defaults', async () => {
    await expect(handler('config:set')({}, { theme: 'light' })).resolves.toEqual({ success: true })

    expect(JSON.parse(fs.readFileSync(path.join(velaHome, 'config.json'), 'utf8'))).toMatchObject({
      theme: 'light',
      defaultModelId: null,
    })
  })

  it('keeps stage model assignments out of the blind config merge', async () => {
    const configPath = path.join(velaHome, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ defaultModelId: null, stageModelIds: { review: 'reviewer' } }))

    await expect(handler('config:set')({}, { theme: 'light', stageModelIds: { review: 'stale-snapshot', planning: 'other' } })).resolves.toEqual({ success: true })

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ defaultModelId: null, theme: 'light', stageModelIds: { review: 'reviewer' } })
  })
})
