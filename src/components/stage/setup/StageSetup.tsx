import { useId, useState, type ReactNode } from 'react'
import { ArrowRight, LoaderCircle, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../../shared/narrative-thread'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { missingSetup } from '../../../stores/navigation/stage-progress'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { configFieldsToExpand, startConfigGeneration } from '../../dialogs/config-generation'
import { AUDIENCE_EN, GENRE_EN } from '../../editor/novel-config-labels'
import { NOVEL_GENRES, novelConfigSessionKey, useNovelConfigForm } from '../../editor/use-novel-config-form'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'
import ModelMissingNotice from '../ModelMissingNotice'
import { commandLabel } from '../shortcut-keys'
import { useModelMissing } from '../use-model-missing'
import { ONE_MISSING_HINT, POV_OPTIONS, REQUIRED_NAMES, STRUCTURE_OPTIONS } from './setup-fields'
import { ConfigSection } from './ConfigFieldDocument'
import { TEXT_FIELDS, openConfigField } from './config-fields'

type Form = ReturnType<typeof useNovelConfigForm>

/** 作者此刻在哪：活动标签、书房还是作品、设置页开没开。 */
function authorPlace(): string {
  const { sidebarView, settingsOpen } = useLayoutStore.getState()
  return JSON.stringify([useEditorStore.getState().activeTabId, sidebarView, settingsOpen])
}

/** 架构目录与长文本二级编辑页共用配置保存会话。 */
export default function StageSetup({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  return <SetupSession key={novelConfigSessionKey(currentProject, projectKey)} projectKey={projectKey} />
}

/** 数字框允许暂时为空，失焦时回退到默认值。 */
function NumberInput({ id, value, fallback, min, max, label, onChange }: {
  id?: string
  value: number | ''
  fallback: number
  min: number
  max?: number
  label: string
  onChange: (value: number | '') => void
}) {
  return (
    <input
      id={id}
      className="stage-setup-num-input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={value}
      onChange={event => onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))}
      onBlur={() => { if (!(Number(value) >= min)) onChange(fallback) }}
    />
  )
}

/** 不可用按钮的原因藏在旁边，读屏用户聚焦按钮时能听到；看得见的原因在页面别处（缺模型提示条、必填标记）。 */
function DisabledReason({ id, reason }: { id: string; reason: string | null }) {
  return reason ? <span id={id} className="stage-visually-hidden">{reason}</span> : null
}

function SettingRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="stage-setup-panel stage-setup-option">
    <div className="stage-setup-adv-row">
      <div><div className="stage-setup-label">{label}</div><p className="stage-setup-panel-desc">{description}</p></div>
      <div className="stage-setup-adv-ctl">{children}</div>
    </div>
  </div>
}

function AdvancedPanel({ config, form }: { config: NovelConfig; form: Form }) {
  const text = useLocaleStore(s => s.text)
  const inputId = useId()
  const threshold = resolveNarrativeThreadDormantThreshold(config.narrativeThreadDormantChapterThreshold)
  return (
    <section className="stage-setup-panel" aria-label={text('伏笔提醒', 'Thread reminder')}>
      <div className="stage-setup-adv-row">
        <div>
          <label className="stage-setup-label" htmlFor={inputId}>{text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}</label>
          <p className="stage-setup-panel-desc">{text(
            `一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} 章。`,
            `The plot page flags a thread that has not moved for this many chapters. Default ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}.`,
          )}</p>
        </div>
        <div className="stage-setup-adv-ctl">
          <NumberInput id={inputId} value={config.narrativeThreadDormantChapterThreshold as unknown === '' ? '' : threshold}
            fallback={DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD} max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD} label={text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}
            onChange={value => form.update('narrativeThreadDormantChapterThreshold', (value === '' ? '' : resolveNarrativeThreadDormantThreshold(value)) as number)} />

        </div>
      </div>
    </section>
  )
}

function SetupSession({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const form = useNovelConfigForm(projectKey)
  const modelMissing = useModelMissing('planning')
  const filling = useWorkflowStore(s => s.activeRuns.some(run => run.type === 'config_generation' && sameProjectPathKey(run.projectPath, projectKey)))
  const [expandFields, setExpandFields] = useState<string[] | null>(null)
  const hintId = useId()
  const fillReasonId = useId()

  const { config } = form
  if (!config) {
    return (
      <div className="stage-setup stage-setup--empty">
        <p className="stage-setup-lede">{form.projectMatches
          ? text('正在读取设定…', 'Loading setup…')
          : text('这个标签属于另一部作品，切回那部作品后再继续。', 'This tab belongs to another book. Switch back to it to continue.')}</p>
      </div>
    )
  }

  const missing = missingSetup(config).filter(field => field !== 'coreOutline')
  const hint = missing.length === 0
    ? text('基本信息已齐全', 'Book details are complete.')
    : missing.length === 1
      ? text(...ONE_MISSING_HINT[missing[0]])
      : text(`还差 ${missing.length} 项：${missing.map(field => REQUIRED_NAMES[field][0]).join('、')}`,
        `${missing.length} left: ${missing.map(field => REQUIRED_NAMES[field][1]).join(', ')}`)
  const aiReason = modelMissing ? text('先在设置里添加 AI 模型', 'Add an AI model in Settings first') : null
  const fillReason = aiReason ?? (config.coreOutline.trim() ? null : text('先写大纲，AI 按它补全其余设定', 'Write the outline first; AI fills in the rest from it'))

  const startFill = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    if (startConfigGeneration({ idea: config.coreOutline, projectSession: session, onGenerated: form.applyGeneratedTo(session) })) setExpandFields(null)
  }
  const requestFill = () => {
    const fields = configFieldsToExpand(config, text)
    if (fields.length > 0) setExpandFields(fields)
    else startFill()
  }
  const goNext = async () => {
    if (form.dirty) {
      const before = authorPlace()
      try {
        if (!await form.save(true)) return
      } catch {
        return
      }
      // 保存期间作者可能回了书房、开了设置页或换到别的标签；这时不再把作者拉去架构。
      if (authorPlace() !== before) return
    }
    navigate({ kind: 'stage', stage: 'blueprint' })
  }

  const genre = config.genre
  const audience = config.targetAudience
  return (
    <div className="stage-setup">
      <div className="stage-setup-scroll">
        <div className="stage-setup-inner">
          {modelMissing && <ModelMissingNotice />}
          <header className="stage-setup-group-head"><h1>{text('写作选项', 'Writing options')}</h1><p>{text('配置作品的基本信息、写作选项与参考作品。', 'Set book details, writing options and references.')}</p></header>
          <section className="stage-setup-basics" aria-label={text('基本信息', 'Book details')}>
            <header className="stage-setup-group-head"><h2>{text('基本信息', 'Book details')}</h2><p>{text('确定作品的类型、规模与读者。', 'Define the genre, length and audience of this book.')}</p></header>
            <SettingRow label={text('类型', 'Genre')} description={text('作品所属的主要类型。', 'The main genre of this book.')}>
              <select aria-label={text('类型', 'Genre')} className="stage-select" value={genre} onChange={event => form.update('genre', event.target.value)}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {genre && !NOVEL_GENRES.includes(genre) && <option value={genre}>{genre}</option>}
                {NOVEL_GENRES.map(value => <option key={value} value={value}>{text(value, GENRE_EN[value] ?? value)}</option>)}
              </select>
            </SettingRow>
            <SettingRow label={text('细分类型', 'Subgenre')} description={text('更具体的题材，如修仙、重生或末世。', 'A more specific category, such as rebirth or post-apocalyptic fiction.')}>
              <input aria-label={text('细分类型', 'Subgenre')} className="pi-input" value={config.subGenre ?? ''} onChange={event => form.update('subGenre', event.target.value)} />
            </SettingRow>
            <SettingRow label={text('篇幅', 'Length')} description={text('计划的总章数及每章目标字数。', 'Planned chapter count and target length per chapter.')}>
              <div className="stage-setup-length">
                <NumberInput value={config.totalChapters as number | ''} fallback={100} min={1} label={text('总章数', 'Total chapters')} onChange={value => form.update('totalChapters', value as number)} />
                <span>{text('章 · 每章约', 'ch. ·')}</span>
                <NumberInput value={config.wordsPerChapter as number | ''} fallback={3000} min={100} label={text('每章字数', 'Words per chapter')} onChange={value => form.update('wordsPerChapter', value as number)} />
                <span>{text('字', 'words')}</span>
              </div>
            </SettingRow>
            <SettingRow label={text('目标读者', 'Target readers')} description={text('这部作品主要写给谁。', 'Who this book is written for.')}>
              <select aria-label={text('目标读者', 'Target readers')} className="stage-select" value={audience} onChange={event => form.update('targetAudience', event.target.value)}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {audience && !Object.hasOwn(AUDIENCE_EN, audience) && <option value={audience}>{audience}</option>}
                {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => <option key={value} value={value}>{text(value, labelEn)}</option>)}
              </select>
            </SettingRow>
          </section>
          <section className="stage-setup-basics" aria-label={text('叙事与提醒', 'Narration and reminders')}>
            <header className="stage-setup-group-head"><h2>{text('叙事与提醒', 'Narration and reminders')}</h2><p>{text('设置叙事方式与伏笔提醒。', 'Set narration and thread reminders.')}</p></header>
            <SettingRow label={text('叙事视角', 'Point of view')} description={text('故事从谁的视角展开。', 'The perspective used to tell the story.')}>
              <select aria-label={text('叙事视角', 'Point of view')} className="stage-select" value={config.narrativePOV || 'third_limited'} onChange={event => form.update('narrativePOV', event.target.value as NovelConfig['narrativePOV'])}>
                {POV_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
              </select>
            </SettingRow>
            <SettingRow label={text('故事结构', 'Story structure')} description={text('组织情节推进的整体方式。', 'The overall structure of the plot.')}>
              <select aria-label={text('故事结构', 'Story structure')} className="stage-select" value={config.plotStructure || 'three_act'} onChange={event => form.update('plotStructure', event.target.value as NovelConfig['plotStructure'])}>
                {STRUCTURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
              </select>
            </SettingRow>
            <SettingRow label={text('写作语言', 'Writing language')} description={text('AI 生成正文时使用的语言。', 'The language used for generated prose.')}>
              <span className="stage-setup-fixed-value">{text('简体中文', 'Simplified Chinese')}</span>
            </SettingRow>
            <AdvancedPanel config={config} form={form} />
          </section>
          <section className="stage-setup-basics" aria-label={text('参考作品', 'Reference works')}>
          {TEXT_FIELDS.filter(field => field.id === 'referenceWorks').map(field => <ConfigSection key={field.id} field={field} numeral="" config={config} form={form} aiReason={aiReason} onEdit={() => openConfigField(field, projectKey)} />)}
          </section>
        </div>
      </div>

      <footer className="stage-setup-foot">
        <Button variant="secondary" disabled={fillReason !== null || filling} aria-describedby={fillReason ? fillReasonId : undefined} onClick={requestFill}>
          {filling ? <LoaderCircle size={15} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={15} className="stage-setup-spark" aria-hidden="true" />}
          {filling ? text('AI 正在补全…', 'AI is filling in…') : text('AI 补全其余设定', 'Fill the rest with AI')}
        </Button>
        <DisabledReason id={fillReasonId} reason={fillReason} />
        {form.saveOutcome === 'failed'
          ? <span className="stage-setup-hint" id={hintId} data-tone="danger" role="alert">{text('没能保存。设定还在这一页，没有丢，可以再保存一次。', 'Could not save. Your setup is still on this page; try saving again.')}</span>
          : <span className="stage-setup-hint" id={hintId} data-ready={missing.length === 0 || undefined} role="status">{hint}</span>}
        {form.dirty && (
          <Button variant="text" disabled={form.saving} onClick={() => void form.save()}>
            {form.saving ? text('正在保存…', 'Saving…') : text('保存', 'Save')}<kbd>{commandLabel('s')}</kbd>
          </Button>
        )}
        <Button variant="primary" disabled={missing.length > 0 || form.saving} aria-describedby={hintId} onClick={() => void goNext()}>
          {text('下一步：故事规划', 'Next: story planning')}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </footer>

      <InkDialog
        open={expandFields !== null}
        onOpenChange={next => { if (!next) setExpandFields(null) }}
        title={text('扩写已有的设定？', 'Expand what you have written?')}
        description={text('下面这些已经有你写的内容。AI 会保留原文，只在后面补充：', 'These already have your writing. AI keeps it and only adds to it:')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setExpandFields(null)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={startFill}>{text('继续扩写', 'Expand')}</Button>
          </>
        )}
      >
        <ul className="stage-setup-expand-list">
          {expandFields?.map(field => <li key={field}>{field}</li>)}
        </ul>
      </InkDialog>
    </div>
  )
}
