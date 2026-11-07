import { describe, expect, it, vi } from 'vitest'
import { importTavernPreset, type TavernSettings } from '../../../src/shared/sillytavern-preset'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { applyTavernPreset, applyTavernTask } from '../sillytavern-presets'

vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: '/config.json', tryReadJsonFile: () => ({ status: 'missing' }) }))

const entry = importTavernPreset(JSON.stringify({ prompts: [{ identifier: 'main', content: 'Imported guidance {{user}}' }, { identifier: 'chatHistory', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] }), 'test.json', 'id')
const settings: TavernSettings = { presets: [entry], activePresetId: 'id', scope: 'text' }
const task: GenerationTask = { purpose: 'write', output: 'visible-text', messages: [{ role: 'system', content: 'contract' }, { role: 'user', content: 'protected' }],
  promptBudget: { limitUtf8Bytes: 1000, sections: [{ sectionName: 'material', messageIndex: 1, finalText: 'protected' }] } }

describe('preset at generation boundary', () => {
  it('composes actual provider input before budgeting and rebases protected sections', () => {
    const result = applyTavernTask(task, settings)
    expect(result.messages.map(m => m.content)).toEqual(['contract', 'Imported guidance 作者', 'protected'])
    expect(result.promptBudget?.sections[0].messageIndex).toBe(2)
    expect(task.messages).toHaveLength(2)
    expect(task.promptBudget?.sections[0].messageIndex).toBe(1)
  })
  it('does not apply disabled presets or text-only presets to structured tasks', () => {
    expect(applyTavernTask({ ...task, output: 'structured-data' }, settings)).toEqual({ ...task, output: 'structured-data' })
    expect(applyTavernTask(task, { ...settings, activePresetId: null })).toEqual(task)
    expect(applyTavernPreset(task.messages, false)).toEqual(task.messages)
    expect(applyTavernTask({ ...task, output: 'structured-data' }, { ...settings, scope: 'all' }).messages).toHaveLength(3)
  })
})
