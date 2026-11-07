import type { GlobalConfig } from '../../src/shared/ipc-channels'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { activeTavernPreset, parseTavernSettings, type TavernSettings } from '../../src/shared/sillytavern-preset'
import { composeTavernMessages, type TavernMessage } from '../../src/shared/sillytavern-compose'
import { GLOBAL_CONFIG_PATH, tryReadJsonFile } from '../utils/config-utils'

export function readTavernSettings(): TavernSettings {
  const result = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
  if (result.status === 'error') throw new Error('SILLYTAVERN_CONFIG_UNREADABLE', { cause: result.error })
  return parseTavernSettings(result.status === 'ok' ? result.value.sillyTavern : undefined)
}

export function applyTavernPreset(messages: readonly TavernMessage[], structured: boolean, settings = readTavernSettings()): TavernMessage[] {
  const entry = activeTavernPreset(settings)
  if (!entry || (structured && settings.scope !== 'all')) return [...messages]
  return composeTavernMessages(entry, messages).messages
}

/** Compose before token admission. Rebase protected-section indices without changing their text. */
export function applyTavernTask(task: GenerationTask, settings = readTavernSettings()): GenerationTask {
  const messages = applyTavernPreset(task.messages, task.output === 'structured-data', settings)
  return { ...task, messages, ...(task.promptBudget ? { promptBudget: { ...task.promptBudget,
    sections: task.promptBudget.sections.map(section => ({ ...section, messageIndex: messages.indexOf(task.messages[section.messageIndex]) })) } } : {}) }
}
