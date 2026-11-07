import { useId, useState } from 'react'
import { FileText, LoaderCircle, Sparkles } from 'lucide-react'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useNovelConfigForm } from '../../editor/use-novel-config-form'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { SaveFeedback } from '../../editor/save-feedback'
import { Button } from '../../ui/Button'
import { useModelMissing } from '../use-model-missing'
import type { TextField } from './config-fields'
type Form = ReturnType<typeof useNovelConfigForm>
function DisabledReason({ id, reason }: { id: string; reason: string | null }) {
  return reason ? <span id={id} className="stage-visually-hidden">{reason}</span> : null
}
function AiButton({ field, label, form, disabledReason }: { field: GeneratableField; label: string; form: Form; disabledReason: string | null }) {
  const text = useLocaleStore(s => s.text)
  const reasonId = useId()
  const busy = form.generatingField === field
  const reason = disabledReason ?? (form.generatingField !== null && !busy ? text('正在生成另一项，完成后再试', 'Another field is generating. Try again when it finishes') : null)
  return (
    <>
      <Button
        variant="text"
        size="sm"
        className="stage-setup-ai"
        disabled={reason !== null || busy}
        aria-describedby={reason ? reasonId : undefined}
        aria-label={text(`AI 生成「${label}」`, `Generate “${label}” with AI`)}
        onClick={() => void form.generateField(field)}
      >
        {busy ? <LoaderCircle size={13} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
        {busy ? text('生成中…', 'Generating…') : text('AI 生成', 'Generate')}
      </Button>
      <DisabledReason id={reasonId} reason={reason} />
    </>
  )
}

/** 单项 AI 生成失败时写在那一项下面，直到下次生成。 */
function GenerateError({ field, label, form }: { field: GeneratableField; label: string; form: Form }) {
  const text = useLocaleStore(s => s.text)
  if (form.generateError?.field !== field) return null
  const reason = displayedErrorMessage(useLocaleStore.getState().locale, form.generateError.message)
  return (
    <p className="stage-setup-error" role="alert">
      {text(`「${label}」没有生成：${reason}。原来的内容没有改动。`, `“${label}” was not generated: ${reason}. Nothing was changed.`)}
    </p>
  )
}

export default function ConfigFieldDocument({ projectKey, field }: { projectKey: string; field: TextField }) {
  const text = useLocaleStore(s => s.text)
  const form = useNovelConfigForm(projectKey)
  const missingModel = useModelMissing('planning')
  const [count, setCount] = useState(0)
  if (!form.config) return null
  const name = text(...field.name)
  return <div className="h-full flex flex-col overflow-hidden">
    <div className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0" style={{ borderBottom: '1px solid var(--color-border)', backgroundColor: 'var(--color-editor-bg)' }}>
      <div className="flex items-center gap-1.5 min-w-0">
        <FileText size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>{name}</span>
        <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--color-text-muted)' }}>— {text(...field.desc)}</span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{count} {text('字', 'words')}</span>
        <SaveFeedback dirty={form.dirty} saving={form.saving} outcome={form.saveOutcome} />
        {form.dirty && <Button variant="outline" size="sm" disabled={form.saving} onClick={() => void form.save()}>{text('保存', 'Save')}</Button>}
        {field.aiField && <AiButton field={field.aiField} label={name} form={form} disabledReason={missingModel ? text('先在设置里添加 AI 模型', 'Add an AI model in Settings first') : null} />}
      </div>
    </div>
    {field.aiField && <GenerateError field={field.aiField} label={name} form={form} />}
    <div className="flex-1 overflow-hidden">
      <CodeMirrorEditor key={field.id} mode="document" hideStatusBar content={form.config[field.id] ?? ''}
        onChange={value => form.update(field.id, value)} onSave={async () => { await form.save() }} onCharCountChange={setCount}
        placeholder={text('尚未生成内容，点击右上角「AI 生成」或直接在此编辑...', 'No content yet. Click “AI Generate” in the top-right or start editing here...')} />
    </div>
  </div>
}
