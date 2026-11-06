import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { MoreHorizontal } from 'lucide-react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { useLocaleStore } from '../../../stores/locale-store'
import type { EditableChapterBlueprintField } from '../../editor/chapter-card-draft-ledger'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import BlueprintCharacters from './BlueprintCharacters'
import LessAiToneButton from '../../editor/LessAiToneButton'

interface BlueprintCardProps {
  blueprint: ChapterBlueprint
  saving: boolean
  onField: <K extends EditableChapterBlueprintField>(key: K, value: ChapterBlueprint[K]) => void
  onSave: () => void
  onDelete: () => void
  projectKey: string
}

/** 单章故事规划：章节标题、出场角色与规划正文。章号是稳定标识，只读。 */
export default function BlueprintCard({ blueprint, saving, onField, onSave, onDelete, projectKey }: BlueprintCardProps) {
  const text = useLocaleStore(s => s.text)
  const number = blueprint.chapterNumber

  return (
    <section className="stage-bp-card" aria-label={text(`第 ${number} 章故事规划`, `Chapter ${number} blueprint`)}>
      <div className="stage-bp-card-inner">
        <div className="stage-bp-card-bar">
          <span className="stage-bp-card-status">{text(`第 ${number} 章`, `Chapter ${number}`)}</span>
          <span className="stage-bp-card-gap" />
          <LessAiToneButton key={`${projectKey}:${number}`} projectKey={projectKey} targetKey={`blueprint:${number}`} content={blueprint.keyEvents} disabled={saving} onApply={content => onField('keyEvents', content)} />
          <Button variant="secondary" size="sm" disabled={saving} aria-busy={saving || undefined} onClick={onSave}>
            {saving ? text('保存中…', 'Saving…') : text('保存此章', 'Save chapter')}
          </Button>
          <Menu
            label={text(`第 ${number} 章更多操作`, `More for chapter ${number}`)}
            icon={<MoreHorizontal size={16} aria-hidden />}
            align="end"
            groups={[{ id: 'danger', tone: 'danger', label: text('危险', 'Danger'), items: [
              { id: 'delete', label: text('删除此章…', 'Delete chapter…'), onSelect: onDelete },
            ] }]}
          />
        </div>

        <div className="stage-bp-title-row">
          <input
            className="stage-bp-title"
            aria-label={text('章节标题', 'Chapter title')}
            value={blueprint.title}
            placeholder={text('给这一章起个名字', 'Name this chapter')}
            onChange={event => onField('title', event.target.value)}
          />
        </div>
        <BlueprintCharacters key={number} names={blueprint.characters} onChange={names => onField('characters', names)} />
        <div className="stage-bp-plan-editor" role="group" aria-label={text('规划正文', 'Planning text')}>
          <CodeMirrorEditor key={number} mode="prose" fitContent dropCap={false}
            content={blueprint.keyEvents}
            placeholder={text('写下这一章的情节、人物行动、冲突与转折……', 'Plan the events, character actions, conflicts and turns of this chapter…')}
            onChange={content => onField('keyEvents', content)} onSave={onSave} />
        </div>
      </div>
    </section>
  )
}
