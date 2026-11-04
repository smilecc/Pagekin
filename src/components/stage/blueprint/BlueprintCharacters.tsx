import { useEffect, useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { ipc } from '../../../services/ipc-client'
import { globalEventBus } from '../../../shared/event-bus'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { isCommand, isComposing } from '../shortcut-keys'

/** Explicit cast is retained even when the planning prose uses pronouns or titles. */
export default function BlueprintCharacters({ names, onChange }: { names: string[]; onChange: (names: string[]) => void }) {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const listId = useId()
  const [input, setInput] = useState('')
  const [rosterNames, setRosterNames] = useState<{ session: ProjectSessionContext; names: string[] } | null>(null)
  const suggestions = rosterNames && sameProjectSessionContext(rosterNames.session, captureProjectSession(project)) ? rosterNames.names : []
  useEffect(() => {
    const session = captureProjectSession(project)
    let live = true
    if (!session) return
    const load = () => void ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath)
      .then(roster => {
        if (live && isProjectSessionCurrent(session)) setRosterNames({ session, names: roster.status === 'ready' ? [...new Set(roster.entries.map(card => card.name))] : [] })
      })
      .catch(() => { if (live) setRosterNames(null) })
    load()
    const unsubscribe = globalEventBus.on('REFRESH_RESOURCE', event => {
      if (sameProjectSessionContext(event.projectSession, session) && event.resources.some(resource => resource === 'all' || resource === 'characterCards')) load()
    })
    return () => { live = false; unsubscribe() }
  }, [project?.path, project?.sessionLease, project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    const additions = input.split(/[、,，\n]/u).map(name => name.trim()).filter(Boolean)
    if (!additions.length) return
    onChange([...new Set([...names, ...additions])])
    setInput('')
  }
  return (
    <div className="stage-bp-field stage-bp-cast">
      <label htmlFor={`${listId}-input`}>{text('出场角色', 'Characters')}</label>
      <div className="stage-bp-people">
        {names.map(name => <span key={name} className="stage-bp-person">{name}
          <Button variant="icon" size="sm" aria-label={text(`移除出场角色 ${name}`, `Remove character ${name}`)} onClick={() => onChange(names.filter(candidate => candidate !== name))}><X size={12} aria-hidden /></Button>
        </span>)}
        <input id={`${listId}-input`} className="stage-bp-person-input" list={listId} value={input}
          placeholder={text('选择或输入角色姓名', 'Choose or enter a character name')}
          onChange={event => setInput(event.target.value)} onBlur={add}
          onKeyDown={event => {
            if (isComposing(event.nativeEvent)) return
            if (event.key === 'Enter') { event.preventDefault(); add() }
            // 先提交输入中的姓名，再让外壳的保存快捷键读取章节草稿。
            else if (isCommand(event, 's')) add()
          }} />
        <datalist id={listId}>{suggestions.filter(name => !names.includes(name)).map(name => <option key={name} value={name} />)}</datalist>
        <Button variant="icon" size="sm" disabled={!input.trim()} aria-label={text('添加出场角色', 'Add character')} onClick={add}><Plus size={14} aria-hidden /></Button>
      </div>
      <small className="stage-bp-cast-hint">{text('写作时会带入这些角色的资料。多个姓名可用顿号或逗号分隔。', 'These character profiles are included when writing. Separate multiple names with commas.')}</small>
    </div>
  )
}
