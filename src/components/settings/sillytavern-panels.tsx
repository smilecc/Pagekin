import { useState } from 'react'
import { ArrowDown, ArrowUp, Download, Search, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react'
import { pluralEn } from '../../shared/plural-en'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import type { TavernPresetEntry, TavernPrompt, TavernSettings } from '../../shared/sillytavern-preset'
import { discoverTavernVariables } from '../../shared/sillytavern-macros'
import { composeTavernMessages, TAVERN_CONTEXT_DEFAULTS } from '../../shared/sillytavern-compose'

type EditorProps = { entry: TavernPresetEntry; edit: (transform: (entry: TavernPresetEntry) => TavernPresetEntry) => void }
type Preview = ReturnType<typeof composeTavernMessages> & { error: string }
const roleLabel = (role: string, text: (zh: string, en: string) => string) => role === 'user' ? text('用户', 'User') : role === 'assistant' ? text('助手', 'Assistant') : text('系统', 'System')

export function PresetEntries({ entry, edit }: EditorProps) {
  const text = useLocaleStore(s => s.text)
  const order = entry.preset.prompt_order.find(o => o.character_id === entry.orderId)!
  const prompts = new Map(entry.preset.prompts.map(p => [p.identifier, p]))
  const [selectedId, setSelectedId] = useState(() => order.order.find(o => o.enabled && prompts.get(o.identifier)?.content?.trim())?.identifier ?? order.order[0]?.identifier ?? '')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const selected = prompts.get(selectedId)
  const selectedIndex = order.order.findIndex(o => o.identifier === selectedId)
  const enabled = order.order[selectedIndex]?.enabled ?? false
  const visible = order.order.filter(item => {
    const prompt = prompts.get(item.identifier)
    return (filter === 'all' || item.enabled === (filter === 'enabled')) && `${prompt?.name ?? ''} ${prompt?.content ?? ''} ${item.identifier}`.toLowerCase().includes(search.toLowerCase())
  })
  const setEnabled = (identifier: string, value: boolean) => edit(e => ({ ...e, preset: { ...e.preset, prompt_order: e.preset.prompt_order.map(o => o.character_id === e.orderId ? { ...o, order: o.order.map(p => p.identifier === identifier ? { ...p, enabled: value } : p) } : o) } }))
  const patchPrompt = (patch: Partial<TavernPrompt>) => edit(e => ({ ...e, preset: { ...e.preset, prompts: e.preset.prompts.map(p => p.identifier === selectedId ? { ...p, ...patch } : p) } }))
  const move = (delta: number) => edit(e => ({ ...e, preset: { ...e.preset, prompt_order: e.preset.prompt_order.map(o => {
    if (o.character_id !== e.orderId) return o
    const items = [...o.order], index = items.findIndex(p => p.identifier === selectedId), target = index + delta
    if (index < 0 || target < 0 || target >= items.length) return o
    ;[items[index], items[target]] = [items[target], items[index]]
    return { ...o, order: items }
  }) } }))
  const unlisted = entry.preset.prompts.filter(p => !order.order.some(o => o.identifier === p.identifier))

  return <div className="tavern-split">
    <div className="tavern-browser">
      <div className="tavern-browser-tools">
        <label className="tavern-search"><Search size={16} aria-hidden /><input type="search" aria-label={text('搜索条目', 'Search prompts')} placeholder={text('搜索名称或内容', 'Search name or content')} value={search} onChange={e => setSearch(e.target.value)} /></label>
        <div className="tavern-list-meta"><select aria-label={text('条目筛选', 'Filter prompts')} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{text('全部条目', 'All prompts')}</option><option value="enabled">{text('仅已启用', 'Enabled only')}</option><option value="disabled">{text('仅未启用', 'Disabled only')}</option></select><span>{text(`${order.order.filter(o => o.enabled).length} 项启用`, `${order.order.filter(o => o.enabled).length} enabled`)}</span></div>
      </div>
      <div className="tavern-list" role="group" aria-label={text('提示词条目列表', 'Prompt entries')}>
        {visible.map(item => {
          const p = prompts.get(item.identifier), name = p?.name || item.identifier
          return <div className="tavern-prompt-row" data-selected={item.identifier === selectedId} data-enabled={item.enabled} key={item.identifier}>
            <input type="checkbox" aria-label={`${text('启用', 'Enable')} ${name}`} checked={item.enabled} onChange={e => setEnabled(item.identifier, e.target.checked)} />
            <button type="button" aria-pressed={item.identifier === selectedId} onClick={() => setSelectedId(item.identifier)} title={name}>
              <span className="tavern-row-name">{name}</span><span className="tavern-row-meta">{String(order.order.indexOf(item) + 1).padStart(2, '0')} · {p?.marker ? text('上下文位置', 'Context marker') : roleLabel(p?.role ?? 'system', text)}{p?.injection_position === 1 ? text(` · 深度 ${p.injection_depth ?? 4}`, ` · Depth ${p.injection_depth ?? 4}`) : ''}</span>
            </button>
          </div>
        })}
        {!visible.length && <div className="tavern-empty"><p>{text('没有匹配的条目', 'No matching prompts')}</p><Button variant="text" size="sm" onClick={() => { setSearch(''); setFilter('all') }}>{text('清除筛选', 'Clear filters')}</Button></div>}
      </div>
      {!!unlisted.length && <label className="tavern-field tavern-unlisted">{text('从预设库添加条目', 'Add from the preset library')}<select value="" onChange={event => {
        const identifier = event.target.value
        if (!identifier) return
        edit(e => ({ ...e, preset: { ...e.preset, prompt_order: e.preset.prompt_order.map(o => o.character_id === e.orderId ? { ...o, order: [...o.order, { identifier, enabled: false }] } : o) } }))
        setSearch(''); setFilter('all'); setSelectedId(identifier)
      }}><option value="">{text(`${unlisted.length} 个未添加条目`, `${unlisted.length} unlisted prompts`)}</option>{unlisted.map(p => <option key={p.identifier} value={p.identifier}>{p.name || p.identifier}</option>)}</select></label>}
    </div>
    <div className="tavern-detail">
      {selected ? <>
        <div className="tavern-detail-head"><span className="tavern-eyebrow">{text('编辑条目', 'Edit prompt')}</span><div className="tavern-actions"><Button variant="icon" size="sm" aria-label={text('上移当前条目', 'Move selected prompt up')} disabled={selectedIndex <= 0} onClick={() => move(-1)}><ArrowUp /></Button><Button variant="icon" size="sm" aria-label={text('下移当前条目', 'Move selected prompt down')} disabled={selectedIndex < 0 || selectedIndex === order.order.length - 1} onClick={() => move(1)}><ArrowDown /></Button></div></div>
        <label className="tavern-field">{text('条目名称', 'Prompt name')}<input value={selected.name ?? ''} onChange={e => patchPrompt({ name: e.target.value })} /></label>
        <label className="tavern-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(selectedId, e.target.checked)} />{text('将此条目加入发送内容', 'Include this prompt in outgoing messages')}</label>
        {selected.marker ? <div className="tavern-marker-info"><SlidersHorizontal aria-hidden /><h3>{text('这是一个上下文位置标记', 'This is a context marker')}</h3><p>{selected.identifier === 'chatHistory' ? text('本轮写作任务和历史消息会插入这里。原有任务内容始终保留。', 'The current writing task and history are inserted here. Original task content is always retained.') : text('内容来自「变量与宏」中的角色、场景或世界信息；此处只控制位置与启用状态。', 'Content comes from character, scenario or world information in Variables. This marker controls its position and inclusion.')}</p></div> : <>
          <div className="tavern-form-grid"><label className="tavern-field">{text('消息角色', 'Message role')}<select value={selected.role ?? 'system'} onChange={e => patchPrompt({ role: e.target.value as TavernPrompt['role'] })}>{['system', 'user', 'assistant'].map(role => <option key={role} value={role}>{roleLabel(role, text)}</option>)}</select></label><label className="tavern-field">{text('插入位置', 'Insertion position')}<select value={selected.injection_position ?? 0} onChange={e => patchPrompt({ injection_position: Number(e.target.value) })}><option value={0}>{text('按列表顺序', 'Relative order')}</option><option value={1}>{text('聊天历史内', 'In chat history')}</option></select></label></div>
          {selected.injection_position === 1 && <div className="tavern-form-grid"><label className="tavern-field">{text('深度（0 = 最后）', 'Depth (0 = end)')}<input type="number" min={0} max={10000} value={selected.injection_depth ?? 4} onChange={e => patchPrompt({ injection_depth: Math.max(0, Number(e.target.value)) })} /></label><label className="tavern-field">{text('同深度顺序', 'Order at depth')}<input type="number" min={0} max={10000} value={selected.injection_order ?? 100} onChange={e => patchPrompt({ injection_order: Math.max(0, Number(e.target.value)) })} /></label></div>}
          <label className="tavern-field tavern-content-field">{text('条目内容', 'Prompt content')}<textarea aria-label={text('条目内容', 'Prompt content')} className="tavern-code" rows={13} value={selected.content ?? ''} spellCheck={false} onChange={e => patchPrompt({ content: e.target.value })} /></label>
          <small className="tavern-muted">{text(`${(selected.content ?? '').length.toLocaleString()} 字符 · 支持 {{变量}} 与嵌套宏`, `${(selected.content ?? '').length.toLocaleString()} ${pluralEn((selected.content ?? '').length, 'character')} · Supports {{variables}} and nested macros`)}</small>
        </>}
      </> : <div className="tavern-empty">{text('选择一个条目，查看并编辑内容', 'Select a prompt to view and edit')}</div>}
    </div>
  </div>
}

type VariableKind = 'variables' | 'globalVariables' | 'macros'
interface VariableItem { name: string; kind: VariableKind; key: string; missing: boolean }
const MARKER_KEYS: Record<string, string> = { charDescription: 'description', charPersonality: 'personality', scenario: 'scenario', personaDescription: 'persona', worldInfoBefore: 'worldinfobefore', worldInfoAfter: 'worldinfoafter', dialogueExamples: 'mesexamples' }

export function PresetVariables({ entry, edit, preview }: EditorProps & { preview: Preview }) {
  const text = useLocaleStore(s => s.text)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState('all')
  const activeIds = new Set(entry.preset.prompt_order.find(o => o.character_id === entry.orderId)?.order.filter(o => o.enabled).map(o => o.identifier))
  const sources = entry.preset.prompts.filter(p => showAll || activeIds.has(p.identifier))
  const discovered = discoverTavernVariables(sources.map(p => p.content ?? ''))
  const missing = new Set(preview.warnings.filter(w => w.startsWith('Unresolved macro')).flatMap(w => [...w.matchAll(/\{\{\s*([^\s:{}]+)/g)].map(m => m[1].toLowerCase())))
  const macroKeys = ['user', 'char', ...sources.flatMap(p => p.marker && MARKER_KEYS[p.identifier] ? [MARKER_KEYS[p.identifier]] : []), ...discovered.macros, ...Object.keys(entry.macros)]
  const items: VariableItem[] = (['variables', 'globalVariables', 'macros'] as const).flatMap(kind => [...new Set(kind === 'macros' ? macroKeys : [...discovered[kind], ...Object.keys(entry[kind])])].map(name => ({ name, kind, key: `${kind}:${name}`, missing: kind === 'macros' && missing.has(name) }))).sort((a, b) => Number(b.missing) - Number(a.missing))
  const [selectedKey, setSelectedKey] = useState(() => items[0]?.key ?? '')
  const visible = items.filter(item => item.name.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || (filter === 'missing' ? item.missing : Object.hasOwn(entry[item.kind], item.name))))
  const selected = items.find(item => item.key === selectedKey) ?? visible[0]
  const value = (item: VariableItem) => item.kind === 'macros' ? entry.macros[item.name] ?? TAVERN_CONTEXT_DEFAULTS[item.name] ?? '' : preview[item.kind][item.name] ?? ''
  const override = selected ? Object.hasOwn(entry[selected.kind], selected.name) : false
  const setValue = (item: VariableItem, next: string) => edit(e => ({ ...e, [item.kind]: { ...e[item.kind], [item.name]: next } }))
  const reset = (item: VariableItem) => edit(e => ({ ...e, [item.kind]: Object.fromEntries(Object.entries(e[item.kind]).filter(([key]) => key !== item.name)) }))
  const kindLabel = (item: VariableItem) => item.kind === 'variables' ? text('预设变量', 'Preset variable') : item.kind === 'globalVariables' ? text('全局变量', 'Global variable') : text('上下文 / 宏', 'Context / macro')

  return <div className="tavern-split">
    <div className="tavern-browser">
      <div className="tavern-browser-tools"><label className="tavern-search"><Search size={16} aria-hidden /><input type="search" aria-label={text('搜索变量', 'Search variables')} placeholder={text('搜索变量或宏', 'Search variables or macros')} value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label={text('变量筛选', 'Filter variables')} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{text('全部变量', 'All variables')}</option><option value="missing">{text('待填写的宏', 'Macros needing values')}</option><option value="overridden">{text('已自定义', 'Customized')}</option></select><label className="tavern-check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />{text('包含未启用条目的变量', 'Include disabled prompts')}</label></div>
      <div className="tavern-list" role="group" aria-label={text('变量列表', 'Variable list')}>{visible.map(item => <button type="button" className="tavern-variable-row" data-selected={selected?.key === item.key} aria-pressed={selected?.key === item.key} aria-label={`${text('编辑变量', 'Edit variable')} ${item.kind === 'globalVariables' ? '$' : ''}${item.name}`} key={item.key} onClick={() => setSelectedKey(item.key)}><span className="tavern-row-name">{item.name}{item.missing && <span className="tavern-badge tavern-attention">{text('待填写', 'Needs value')}</span>}</span><span className="tavern-row-meta">{kindLabel(item)} · {Object.hasOwn(entry[item.kind], item.name) ? text('已自定义', 'Customized') : text('跟随预设', 'From preset')}</span></button>)}{!visible.length && <div className="tavern-empty">{text('没有匹配的变量', 'No matching variables')}</div>}</div>
    </div>
    <div className="tavern-detail">
      {selected ? <>
        <span className="tavern-eyebrow">{kindLabel(selected)}</span><h3 className="tavern-variable-title">{selected.name}</h3>
        <code className="tavern-token">{selected.kind === 'macros' ? `{{${selected.name}}}` : `{{${selected.kind === 'globalVariables' ? 'getglobalvar' : 'getvar'}::${selected.name}}}`}</code>
        <p className="tavern-help">{selected.missing ? text('此宏没有自动值。填写后会替换提示词中的占位符。', 'This macro has no automatic value. Fill it in to replace its placeholder.') : selected.kind === 'macros' ? text('填写自定义值，或恢复自动值。真实任务中的输入和最近消息会自动提供。', 'Set a custom value or restore the automatic value. Input and recent messages come from the actual task.') : text('默认跟随已启用条目的赋值。打开覆盖后，可固定你的偏好，优先于预设中的 setvar。', 'By default, values come from enabled prompts. Override to fix your preference ahead of preset assignments.')}</p>
        {selected.kind !== 'macros' && <label className="tavern-check"><input type="checkbox" aria-label={`${text('覆盖', 'Override')} ${selected.name}`} checked={override} onChange={e => e.target.checked ? setValue(selected, value(selected)) : reset(selected)} />{text('使用自定义值', 'Use a custom value')}</label>}
        <label className="tavern-field tavern-content-field">{override || selected.kind === 'macros' ? text('自定义值', 'Custom value') : text('当前解析值（只读）', 'Resolved value (read only)')}<textarea aria-label={selected.kind === 'macros' ? `{{${selected.name}}}` : `${selected.kind === 'globalVariables' ? 'global ' : ''}${selected.name}`} rows={12} readOnly={selected.kind !== 'macros' && !override} value={override ? entry[selected.kind][selected.name] : selected.kind === 'macros' ? '' : value(selected)} placeholder={selected.kind === 'macros' ? TAVERN_CONTEXT_DEFAULTS[selected.name] || text('自动提供；未识别的宏需要填写', 'Automatic; unrecognized macros need a value') : text('启用条目尚未赋值', 'No value from enabled prompts')} onChange={e => setValue(selected, e.target.value)} /></label>
        {override && <Button variant="text" size="sm" onClick={() => reset(selected)}><Undo2 aria-hidden />{text('恢复预设 / 自动值', 'Restore preset / automatic value')}</Button>}
        <small className="tavern-muted">{text('变量在每次请求内计算，运行中的变化不会写回设置。', 'Variables are evaluated per request. Runtime changes are not written back to settings.')}</small>
      </> : <div className="tavern-empty">{text('选择一个变量，查看或调整它的值', 'Select a variable to inspect or change its value')}</div>}
    </div>
  </div>
}

export function PresetPreview({ preview, input, setInput, onVariables }: { preview: Preview; input: string; setInput: (value: string) => void; onVariables: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [role, setRole] = useState('all')
  const [expanded, setExpanded] = useState(false)
  const unresolved = preview.warnings.filter(w => w.startsWith('Unresolved macro'))
  const otherWarnings = preview.warnings.filter(w => !w.startsWith('Unresolved macro'))
  return <div className="tavern-preview">
    <div className="tavern-preview-head"><div><h3>{text('检查模型将收到什么', 'See what the model receives')}</h3><p className="tavern-help">{text('预览使用示例任务和固定随机值。实际生成会代入真实任务。', 'Preview uses a sample task and fixed random values. Generation substitutes the actual task.')}</p></div><span className="tavern-badge">{text(`${preview.messages.length} 条消息`, `${preview.messages.length} messages`)}</span></div>
    <label className="tavern-field">{text('预览任务', 'Preview task')}<textarea aria-label={text('预览任务', 'Preview task')} rows={2} value={input} placeholder={text('例如：续写主角进入古城后的场景…', 'For example: Continue the scene as the protagonist enters the city…')} onChange={e => setInput(e.target.value)} /></label>
    {preview.error && <p role="alert" className="tavern-feedback tavern-feedback--error">{preview.error}</p>}
    {!!unresolved.length && <div className="tavern-feedback tavern-feedback--warning"><span>{text(`${unresolved.length} 个宏尚未解析，将原样发送。`, `${unresolved.length} macros are unresolved and will be sent as written.`)}</span><Button variant="text" size="sm" onClick={onVariables}>{text('去填写变量', 'Set variable values')}</Button></div>}
    {!!otherWarnings.length && <details className="tavern-compatibility"><summary>{text('兼容性说明', 'Compatibility notes')}</summary><ul>{otherWarnings.map(w => { const [en, zh] = w.split(' / '); const detail = zh?.match(/: (.*)$/)?.[0] ?? ''; return <li key={w}>{text(zh ?? w, en + (en.includes(':') ? '' : detail))}</li> })}</ul></details>}
    <div className="tavern-preview-tools"><select aria-label={text('消息角色筛选', 'Filter message role')} value={role} onChange={e => setRole(e.target.value)}><option value="all">{text('全部角色', 'All roles')}</option>{['system', 'user', 'assistant'].map(r => <option key={r} value={r}>{roleLabel(r, text)}</option>)}</select><label className="tavern-check"><input type="checkbox" checked={expanded} onChange={e => setExpanded(e.target.checked)} />{text('展开全部消息', 'Expand all messages')}</label><span className="tavern-muted">{text(`${preview.messages.reduce((sum, m) => sum + m.content.length, 0).toLocaleString()} 字符`, `${preview.messages.reduce((sum, m) => sum + m.content.length, 0).toLocaleString()} ${pluralEn(preview.messages.reduce((sum, m) => sum + m.content.length, 0), 'character')}`)}</span></div>
    <div className="tavern-message-list">{preview.messages.map((message, i) => role !== 'all' && message.role !== role ? null : <details key={`${i}-${expanded}`} className="tavern-message" open={expanded || i === 0}><summary><span className="tavern-message-number">{String(i + 1).padStart(2, '0')}</span><span className="tavern-badge">{roleLabel(message.role, text)}</span><span className="tavern-message-excerpt">{message.content.replace(/\s+/g, ' ').slice(0, 110)}</span></summary><pre>{message.content}</pre></details>)}</div>
  </div>
}

export function PresetOptions({ entry, edit, scope, setScope, onExport, onRemove }: EditorProps & { scope: TavernSettings['scope']; setScope: (value: TavernSettings['scope']) => void; onExport: () => void; onRemove: () => void }) {
  const text = useLocaleStore(s => s.text)
  return <div className="tavern-options">
    <div className="tavern-option-group"><h3>{text('基本信息', 'Preset details')}</h3><label className="tavern-field">{text('预设名称', 'Preset name')}<input value={entry.name} onChange={e => edit(p => ({ ...p, name: e.target.value }))} /></label><label className="tavern-field">{text('提示词顺序组', 'Prompt order group')}<select value={entry.orderId} onChange={e => edit(p => ({ ...p, orderId: Number(e.target.value) }))}>{entry.preset.prompt_order.map(o => <option key={o.character_id} value={o.character_id}>{o.character_id === 100001 ? text('默认顺序 · 100001', 'Default order · 100001') : text(`顺序组 ${o.character_id}`, `Order group ${o.character_id}`)}</option>)}</select></label><p className="tavern-help">{text('大多数预设只有一个顺序组，可保留默认选择。', 'Most presets have one order group. Keep the default unless you need a different group.')}</p></div>
    <div className="tavern-option-group"><h3>{text('应用范围 · 所有作品', 'Generation scope · All books')}</h3><label className="tavern-field">{text('应用范围', 'Apply to')}<select value={scope} onChange={e => setScope(e.target.value as TavernSettings['scope'])}><option value="text">{text('仅文本生成（推荐）', 'Text generation only (recommended)')}</option><option value="all">{text('全部生成（含结构化数据）', 'All generation (including structured data)')}</option></select></label><p className={scope === 'all' ? 'tavern-help tavern-attention' : 'tavern-help'}>{scope === 'all' ? text('预设的输出格式要求可能与 JSON 数据任务冲突。', 'Preset output instructions may conflict with JSON data tasks.') : text('用于文本创作；JSON 等结构化任务继续使用原有输出要求。', 'Used for text generation. JSON and other structured tasks keep their original output requirements.')}</p></div>
    <div className="tavern-option-group"><h3>{text('导出与兼容', 'Export and compatibility')}</h3><p className="tavern-help">{text('导出包含当前条目编辑、开关与顺序。变量覆盖、宏值和应用范围仅保存在本应用中。', 'Export includes current prompt edits, switches and ordering. Variable overrides, macro values and scope are saved only in this app.')}</p><Button variant="secondary" onClick={onExport}><Download aria-hidden />{text('导出 JSON', 'Export JSON')}</Button><details className="tavern-compatibility"><summary>{text('查看兼容范围', 'View compatibility details')}</summary><p>{text('支持常用宏、嵌套变量及普通生成条目。扩展、正则脚本、采样参数只保留用于导出，不执行。未解析的宏会保留并在发送预览中提示。', 'Supports common macros, nested variables and normal-generation prompts. Extensions, regex scripts and sampling parameters are retained for export only. Unresolved macros are preserved and flagged in Preview.')}</p></details></div>
    <div className="tavern-option-group tavern-remove"><div><h3>{text('从预设库移除', 'Remove from library')}</h3><p className="tavern-help">{text('只移除本应用中的副本；原始 JSON 文件不受影响。保存前可撤销。', 'Removes this app’s copy. The original JSON file is unaffected. You can undo before saving.')}</p></div><Button variant="danger" onClick={onRemove}><Trash2 aria-hidden />{text('移除此预设', 'Remove this preset')}</Button></div>
  </div>
}
