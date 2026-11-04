import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { MORE_FIELDS, type MoreField } from './setup-fields'
export type TextField = {
  id: 'coreOutline' | Extract<MoreField, { kind: 'text' }>['id']
  kind: 'text'
  name: readonly [string, string]
  desc: readonly [string, string]
  placeholder: readonly [string, string]
  aiField?: GeneratableField
}
export const TEXT_FIELDS: readonly TextField[] = [
  { id: 'coreOutline', kind: 'text', name: ['大纲', 'Outline'], desc: ['故事的主线、核心冲突与整体走向。', 'The central story, conflict and overall direction.'], placeholder: ['谁，在哪里，想要什么，又被什么挡住了路。', 'Who, where, what they want, and what stands in the way.'], aiField: 'coreOutline' },
  ...MORE_FIELDS.filter((field): field is Extract<MoreField, { kind: 'text' }> => field.kind === 'text'),
]
export function openConfigField(field: TextField, projectKey: string) {
  useEditorStore.getState().openFile({ id: `config:${field.id}`, type: 'config', name: useLocaleStore.getState().text(...field.name), configField: field.id, projectKey })
}

