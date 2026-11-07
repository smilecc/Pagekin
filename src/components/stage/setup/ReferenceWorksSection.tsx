import { useState } from 'react'
import { Check, Ellipsis, PenLine } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { excerpt } from '../architecture/architecture-sections'
import { WritingOptionsSectionHeader } from './WritingOptionsSectionHeader'

export default function ReferenceWorksSection({ content, onEdit, onClear }: {
  content: NovelConfig['referenceWorks']
  onEdit: () => void
  onClear: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const [clearing, setClearing] = useState(false)
  const filled = Boolean(content?.trim())
  return (
    <section className="writing-options-card writing-options-references" data-section="referenceWorks" aria-label={text('参考作品', 'References')}>
      <WritingOptionsSectionHeader numeral="03" title={text('参考作品', 'References')}
        description={text('参考哪些作品的风格、设定或机制。', 'Works whose style, setting or mechanics to draw on.')}
        status={<span className="writing-options-progress" data-ready={filled || undefined}>
          {filled && <Check size={13} aria-hidden />}
          {filled ? text('已填写', 'Filled') : text('未填写', 'Empty')}
        </span>} />
      {filled && <p className="writing-options-reference-preview">{excerpt(content!, text('……', '…'))}</p>}
      <div className="writing-options-reference-actions">
        <Button variant="secondary" size="sm" aria-label={text('编辑参考作品', 'Edit References')} onClick={onEdit}>
          <PenLine size={14} aria-hidden />{filled ? text('编辑', 'Edit') : text('自己写', 'Write it')}
        </Button>
        {filled && <Menu label={text('「参考作品」的更多操作', 'More for References')} icon={<Ellipsis size={16} aria-hidden />} align="end"
          groups={[{ id: 'danger', tone: 'danger', label: text('危险', 'Danger'), items: [{ id: 'clear', label: text('清空此节…', 'Clear this section…'), onSelect: () => setClearing(true) }] }]} />}
      </div>
      <DangerConfirm open={clearing} onOpenChange={setClearing} title={text('清空「参考作品」？', 'Clear References?')}
        consequence={text('将清空此节的全部文本。', 'All text in this section will be cleared.')}
        recoverability={text('此操作无法撤销。', 'This cannot be undone.')} confirmLabel={text('清空此节', 'Clear section')} cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { onClear(); setClearing(false) }} />
    </section>
  )
}
