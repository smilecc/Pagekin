import { useId, useState } from 'react'
import { Ellipsis, FileText, LoaderCircle, PenLine, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useNovelConfigForm } from '../../editor/use-novel-config-form'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { SaveFeedback } from '../../editor/save-feedback'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { useModelMissing } from '../use-model-missing'
import { excerpt } from '../architecture/architecture-sections'
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

export function ConfigSection({ field, numeral, config, form, aiReason, onEdit }: { field: TextField; numeral: string; config: NovelConfig; form: Form; aiReason: string | null; onEdit: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [clearing, setClearing] = useState(false)
  const name = text(...field.name)
  const content = config[field.id] ?? ''
  return (
    <section className="arch-section" data-section={field.id} aria-label={name}>
      <div className="arch-section-head">
        <span className="arch-section-num" aria-hidden>{numeral}</span>
        <div className="arch-section-heading">
          <div className="arch-section-titleline">
            <h2 className="arch-section-title">{name}</h2>
            <span className="arch-badge" data-tone={content.trim() ? 'ok' : 'muted'}>{content.trim() ? text('已填写', 'Filled') : text('未填写', 'Empty')}</span>
          </div>
          <p className="arch-section-summary">{content.trim() ? excerpt(content, text('……', '…')) : text(...field.desc)}</p>
        </div>
        <div className="arch-section-actions">
          <Button variant="text" size="sm" aria-label={text(`编辑${name}`, `Edit ${name}`)} onClick={onEdit}><PenLine size={14} aria-hidden />{content.trim() ? text('编辑', 'Edit') : text('自己写', 'Write it')}</Button>
          {!content.trim() && field.aiField && <AiButton field={field.aiField} label={name} form={form} disabledReason={aiReason} />}
          <Menu label={text(`「${name}」的更多操作`, `More for ${name}`)} icon={<Ellipsis size={16} aria-hidden />} align="end" groups={[
            ...(field.aiField ? [{ id: 'generate', items: [{ id: 'generate', label: text('AI 生成此节…', 'Generate with AI…'), disabled: Boolean(aiReason) || form.generatingField !== null, onSelect: () => { void form.generateField(field.aiField!) } }] }] : []),
            ...(content.trim() ? [{ id: 'danger', tone: 'danger' as const, label: text('危险', 'Danger'), items: [{ id: 'clear', label: text('清空此节…', 'Clear this section…'), onSelect: () => setClearing(true) }] }] : []),
          ]} />
        </div>
      </div>
      {field.aiField && <GenerateError field={field.aiField} label={name} form={form} />}
      <DangerConfirm open={clearing} onOpenChange={setClearing} title={text(`清空「${name}」？`, `Clear ${name}?`)}
        consequence={text('将清空此节的全部文本。', 'All text in this section will be cleared.')}
        recoverability={text('此操作无法撤销。', 'This cannot be undone.')} confirmLabel={text('清空此节', 'Clear section')} cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { form.update(field.id, ''); setClearing(false) }} />
    </section>
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
