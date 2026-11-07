import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Circle, FileUp, Layers3, Save, Undo2 } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'
import { useUnsavedSettings } from './unsaved-settings'
import { activeTavernPreset, EMPTY_TAVERN_SETTINGS, importTavernPreset, MAX_TAVERN_FILE_BYTES, parseTavernSettings, type TavernPresetEntry, type TavernSettings } from '../../shared/sillytavern-preset'
import { composeTavernMessages } from '../../shared/sillytavern-compose'
import { createTavernPreviewRandom } from '../../shared/sillytavern-macros'
import { PresetEntries, PresetVariables, PresetPreview, PresetOptions } from './sillytavern-panels'
import './sillytavern-settings.css'

const tabs = ['entries', 'variables', 'preview', 'options'] as const
type Tab = typeof tabs[number]

export default function SillyTavernSettings() {
  const text = useLocaleStore(s => s.text)
  const [draft, setDraft] = useState<TavernSettings>(EMPTY_TAVERN_SETTINGS)
  const [stored, setStored] = useState<TavernSettings>(EMPTY_TAVERN_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'save' | 'import' | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<Tab>('entries')
  const [previewInput, setPreviewInput] = useState('')
  const [previewSeed, setPreviewSeed] = useState(1)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [removed, setRemoved] = useState<{ entry: TavernPresetEntry; index: number; active: boolean } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored)
  useUnsavedSettings(dirty)
  useEffect(() => {
    let disposed = false
    void ipc.invoke('config:get').then(config => {
      const settings = parseTavernSettings(config?.sillyTavern)
      if (disposed) return
      setDraft(settings); setStored(settings); setSelectedId(settings.activePresetId ?? settings.presets[0]?.id ?? ''); setLoaded(true)
    }).catch(reason => { if (!disposed) setError(displayedErrorMessage(useLocaleStore.getState().locale, reason)) })
    return () => { disposed = true }
  }, [reload])

  const selected = draft.presets.find(p => p.id === selectedId)
  const savedActive = activeTavernPreset(stored)
  const pendingActive = activeTavernPreset(draft)
  const order = selected?.preset.prompt_order.find(o => o.character_id === selected.orderId)
  const preview = useMemo(() => {
    if (!selected) return null
    try { return { ...composeTavernMessages(selected, [{ role: 'user', content: previewInput || text('（本轮写作任务）', '(Current writing task)') }], { random: createTavernPreviewRandom(previewSeed), uuid: () => '00000000-0000-4000-8000-000000000000' }), error: '' } }
    catch (reason) { return { messages: [], warnings: [], variables: {}, globalVariables: {}, error: displayedErrorMessage(useLocaleStore.getState().locale, reason) } }
  }, [selected, previewInput, previewSeed, text])
  const unresolved = preview?.warnings.filter(w => w.startsWith('Unresolved macro')).length ?? 0
  const update = (patch: Partial<TavernSettings>) => { setDraft(previous => ({ ...previous, ...patch })); setNotice('') }
  const editEntry = (transform: (entry: TavernPresetEntry) => TavernPresetEntry) => {
    setDraft(previous => ({ ...previous, presets: previous.presets.map(p => p.id === selectedId ? transform(p) : p) })); setNotice('')
  }
  const importFile = async (file?: File) => {
    if (!file || busy) return
    setBusy('import'); setError(''); setNotice('')
    try {
      if (file.size > MAX_TAVERN_FILE_BYTES) throw new Error(text('文件不能超过 5 MB', 'File must not exceed 5 MB'))
      const entry = importTavernPreset(await file.text(), file.name, crypto.randomUUID())
      setDraft(parseTavernSettings({ ...draft, presets: [...draft.presets, entry] }))
      setSelectedId(entry.id); setTab('entries')
      setNotice(text('导入完成。检查条目后，选择「使用此预设」并保存。', 'Imported. Review the prompts, choose “Use this preset”, then save.'))
    } catch (reason) { setError(displayedErrorMessage(useLocaleStore.getState().locale, reason)) }
    finally { setBusy(null) }
  }
  const save = async () => {
    if (busy || !dirty || !loaded) return
    setBusy('save'); setError(''); setNotice('')
    try {
      const settings = parseTavernSettings(draft)
      const result = await ipc.invoke('config:set', { sillyTavern: settings })
      if (!result.success) throw new Error(result.error)
      setStored(settings); setRemoved(null); setNotice(text('已保存，下次生成使用新设置。', 'Saved. New settings apply to the next generation.'))
    } catch (reason) { setError(displayedErrorMessage(useLocaleStore.getState().locale, reason)) }
    finally { setBusy(null) }
  }
  const exportPreset = () => {
    if (!selected) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected.preset, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${selected.name.replace(/[<>:"/\\|?*]/g, '_')}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const remove = () => {
    if (!selected) return
    setRemoved({ entry: selected, index: draft.presets.indexOf(selected), active: draft.activePresetId === selected.id })
    update({ presets: draft.presets.filter(p => p.id !== selected.id), activePresetId: draft.activePresetId === selected.id ? null : draft.activePresetId })
    setSelectedId(draft.presets.find(p => p.id !== selected.id)?.id ?? '')
  }
  const tabLabels = { entries: text('提示词条目', 'Prompts'), variables: text('变量与宏', 'Variables'), preview: text('发送预览', 'Preview'), options: text('预设设置', 'Preset settings') }

  return <section className="tavern-settings" aria-label={text('提示词预设管理', 'Prompt preset manager')} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
  }}>
    {error && <div className="tavern-feedback tavern-feedback--error" role="alert"><span>{error}</span>{!loaded && <Button variant="secondary" size="sm" onClick={() => { setError(''); setReload(n => n + 1) }}>{text('重新加载', 'Retry')}</Button>}</div>}
    {notice && <p className="tavern-feedback" role="status"><Check size={16} aria-hidden />{notice}</p>}
    {removed && <div className="tavern-feedback" role="status"><span>{text(`已移除「${removed.entry.name}」，保存后生效。`, `“${removed.entry.name}” removed. Save to apply.`)}</span><Button variant="text" size="sm" disabled={!!busy} onClick={() => {
      const presets = [...draft.presets]; presets.splice(removed.index, 0, removed.entry)
      update({ presets, activePresetId: removed.active && !draft.activePresetId ? removed.entry.id : draft.activePresetId })
      setSelectedId(removed.entry.id); setRemoved(null)
    }}><Undo2 aria-hidden />{text('撤销移除', 'Undo removal')}</Button></div>}
    {!loaded && !error && <p role="status" className="tavern-empty">{text('正在加载预设…', 'Loading presets…')}</p>}
    <fieldset disabled={!loaded || !!busy} className="tavern-controls">
      <input ref={fileInput} type="file" accept=".json,application/json" aria-label={text('导入预设文件', 'Import preset file')} className="tavern-file-input" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = '' }} />
      {loaded && !draft.presets.length ? <div className="tavern-empty tavern-onboarding">
        <Layers3 size={32} aria-hidden />
        <h2>{text('从一份预设，开始你的写作风格', 'Start with a preset for your writing')}</h2>
        <p>{text('导入 SillyTavern 对话补全 JSON，即可调整条目、配置变量，并预览发送给模型的内容。', 'Import a SillyTavern chat completion JSON to edit prompts, set variables and preview what the model receives.')}</p>
        <Button variant="primary" onClick={() => fileInput.current?.click()}><FileUp aria-hidden />{text('导入 JSON 预设', 'Import JSON preset')}</Button>
        <small>{text('单个文件不超过 5 MB · 导入后可预览，保存前不会启用', 'Up to 5 MB per file · Preview before enabling and saving')}</small>
      </div> : selected && order && <>
        <div className="tavern-library-bar">
          <label className="tavern-field tavern-library-select">{text('查看 / 编辑预设', 'View / edit preset')}
            <select value={selectedId} onChange={event => setSelectedId(event.target.value)}>{draft.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <Button variant="secondary" onClick={() => fileInput.current?.click()}><FileUp aria-hidden />{busy === 'import' ? text('正在导入…', 'Importing…') : text('导入预设', 'Import preset')}</Button>
        </div>
        <div className="tavern-activation">
          <div><span className="tavern-eyebrow">{text('当前生效 · 所有作品', 'Active · All books')}</span><strong><span className="tavern-status-dot" data-active={!!savedActive} />{savedActive?.name ?? text('未启用预设', 'No preset enabled')}</strong>
            {dirty && <small>{text('保存后生效：', 'After saving: ')}{pendingActive?.name ?? text('关闭预设', 'Presets disabled')}</small>}
          </div>
          <Button variant="secondary" aria-pressed={draft.activePresetId === selected.id} onClick={() => update({ activePresetId: draft.activePresetId === selected.id ? null : selected.id })}>
            {draft.activePresetId === selected.id ? <Check aria-hidden /> : <Circle aria-hidden />}
            {draft.activePresetId === selected.id ? text('停用此预设', 'Disable this preset') : text('使用此预设', 'Use this preset')}
          </Button>
        </div>
        <div className="tavern-workspace">
          <div role="tablist" aria-label={text('预设编辑区', 'Preset editor')} className="tavern-tabs" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            setTab(tabs[index]); document.getElementById(`${id}-${tabs[index]}`)?.focus()
          }}>
            {tabs.map(item => <button type="button" role="tab" id={`${id}-${item}`} aria-controls={`${id}-panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} key={item} onClick={() => setTab(item)}>
              {tabLabels[item]}{item === 'entries' && <span aria-hidden>{order.order.length}</span>}{item === 'variables' && unresolved > 0 && <span className="tavern-attention" aria-label={text(`${unresolved} 个宏待填写`, `${unresolved} macros need values`)}>{unresolved}</span>}
            </button>)}
          </div>
          {tabs.map(item => <div key={item} role="tabpanel" id={`${id}-panel-${item}`} aria-labelledby={`${id}-${item}`} hidden={tab !== item} tabIndex={0} className="tavern-tabpanel">
            {item === 'entries' && <PresetEntries key={`${selected.id}:${selected.orderId}`} entry={selected} edit={editEntry} />}
            {item === 'variables' && preview && <PresetVariables key={`${selected.id}:${selected.orderId}`} entry={selected} edit={editEntry} preview={preview} />}
            {item === 'preview' && preview && <PresetPreview preview={preview} input={previewInput} setInput={setPreviewInput} onReroll={() => setPreviewSeed(seed => seed + 1)} onVariables={() => setTab('variables')} />}
            {item === 'options' && <PresetOptions entry={selected} edit={editEntry} scope={draft.scope} setScope={scope => update({ scope })} onExport={exportPreset} onRemove={remove} />}
          </div>)}
        </div>
      </>}
    </fieldset>
    {loaded && <footer className="tavern-savebar">
      <div><strong>{dirty ? text('有未保存的修改', 'Unsaved changes') : text('所有修改已保存', 'All changes saved')}</strong><small>{text('保存后用于下次生成', 'Applies to the next generation after saving')}</small></div>
      <div className="tavern-actions"><Button variant="text" disabled={!dirty || !!busy} onClick={() => setDiscardOpen(true)}>{text('放弃修改', 'Discard changes')}</Button><Button variant="primary" disabled={!dirty || !!busy} onClick={() => void save()}><Save aria-hidden />{busy === 'save' ? text('保存中…', 'Saving…') : text('保存预设设置', 'Save preset settings')}</Button></div>
    </footer>}
    <DangerConfirm open={discardOpen} onOpenChange={setDiscardOpen} title={text('放弃预设修改？', 'Discard preset changes?')} consequence={text('本页所有未保存的导入、条目和变量修改都将撤销。', 'All unsaved imports, prompt edits and variable changes on this page will be discarded.')} recoverability={text('恢复到上次保存的设置。', 'Returns to the last saved settings.')} confirmLabel={text('放弃修改', 'Discard changes')} cancelLabel={text('继续编辑', 'Keep editing')} onConfirm={() => { setDraft(stored); setSelectedId(stored.activePresetId ?? stored.presets[0]?.id ?? ''); setRemoved(null); setNotice(''); setError('') }} />
  </section>
}
