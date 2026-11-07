import { useId, useState, type ReactNode } from 'react'
import { ArrowRight, BookOpen, Check, LoaderCircle, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../../shared/narrative-thread'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { pluralEn } from '../../../shared/plural-en'
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
import ReferenceWorksSection from './ReferenceWorksSection'
import { WritingOptionsSectionHeader } from './WritingOptionsSectionHeader'
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
function NumberInput({ id, value, fallback, min, max, label, describedBy, onChange }: {
  id?: string
  value: number | ''
  fallback: number
  min: number
  max?: number
  label: string
  describedBy?: string
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
      aria-describedby={describedBy}
      value={value}
      onChange={event => onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))}
      onBlur={() => { if (!(Number(value) >= min)) onChange(fallback) }}
    />
  )
}

function SettingField({ label, description, required, children }: {
  label: string
  description: string
  required?: boolean
  children: (props: { id: string; 'aria-describedby': string; 'aria-required'?: boolean }) => ReactNode
}) {
  const id = useId()
  const text = useLocaleStore(s => s.text)
  return <div className="writing-options-field">
    <label htmlFor={id}>{label}{required && <span className="writing-options-required">{text('必填', 'Required')}</span>}</label>
    {children({ id, 'aria-describedby': `${id}-help`, 'aria-required': required || undefined })}
    <p id={`${id}-help`}>{description}</p>
  </div>
}

function AdvancedPanel({ config, form }: { config: NovelConfig; form: Form }) {
  const text = useLocaleStore(s => s.text)
  const inputId = useId()
  const threshold = resolveNarrativeThreadDormantThreshold(config.narrativeThreadDormantChapterThreshold)
  return (
    <section className="writing-options-reminder" aria-label={text('伏笔提醒', 'Thread reminder')}>
      <div className="stage-setup-adv-row">
        <div>
          <label className="stage-setup-label" htmlFor={inputId}>{text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}</label>
          <p id={`${inputId}-help`} className="stage-setup-panel-desc">{text(
            `一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} 章。`,
            `The plot page flags a thread that has not moved for this many chapters. Default ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}.`,
          )}</p>
        </div>
        <div className="stage-setup-adv-ctl">
          <NumberInput id={inputId} describedBy={`${inputId}-help`} value={config.narrativeThreadDormantChapterThreshold as unknown === '' ? '' : threshold}
            fallback={DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD} max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD} label={text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}
            onChange={value => form.update('narrativeThreadDormantChapterThreshold', (value === '' ? '' : resolveNarrativeThreadDormantThreshold(value)) as number)} />
          <span>{text('章', 'chapters')}</span>
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
  const estimatedLength = config.totalChapters * config.wordsPerChapter
  const lengthSummary = !missing.includes('length') && Number.isSafeInteger(estimatedLength)
    ? text(`预计全书 ${estimatedLength.toLocaleString('zh-CN')} 字`, `Estimated total: ${estimatedLength.toLocaleString('en-US')} ${pluralEn(estimatedLength, 'word')}`)
    : text('填写篇幅后显示全书预估字数', 'Set the length to see the estimated total')
  return (
    <div className="stage-setup stage-setup--options">
      <div className="stage-setup-scroll">
        <div className="stage-setup-inner">
          {modelMissing && <ModelMissingNotice />}
          <header className="stage-setup-group-head writing-options-head">
            <span className="writing-options-eyebrow"><BookOpen size={14} aria-hidden />{text('作品设定', 'BOOK SETUP')}</span>
            <h1>{text('写作选项', 'Writing options')}</h1>
            <p>{text('让故事有方向，让创作有章法。这里的选项将用于这部作品的规划与写作。', 'Give your story direction. These choices guide planning and writing for this book.')}</p>
          </header>
          <section className="writing-options-card" aria-label={text('基本信息', 'Book details')}>
            <WritingOptionsSectionHeader numeral="01" title={text('基本信息', 'Book details')}
              description={text('先确定写什么、写给谁，以及写多长。', 'Start with the genre, readers and length.')}
              status={<span className="writing-options-progress" data-ready={missing.length === 0 || undefined}>
                {missing.length === 0 && <Check size={13} aria-hidden />}
                {text(`${3 - missing.length} / 3 项就绪`, `${3 - missing.length} / 3 ready`)}
              </span>} />
            <div className="writing-options-grid">
              <SettingField label={text('类型', 'Genre')} required description={text('选择作品的主要类型。', 'Choose the main genre of your book.')}>
                {props => <select {...props} aria-label={text('类型', 'Genre')} className="stage-select" value={genre} onChange={event => form.update('genre', event.target.value)}>
                  <option value="" disabled>{text('请选择', 'Choose')}</option>
                  {genre && !NOVEL_GENRES.includes(genre) && <option value={genre}>{genre}</option>}
                  {NOVEL_GENRES.map(value => <option key={value} value={value}>{text(value, GENRE_EN[value] ?? value)}</option>)}
                </select>}
              </SettingField>
              <SettingField label={text('目标读者', 'Target readers')} required description={text('帮助 AI 把握表达方式与内容尺度。', 'Helps AI tailor the tone and content to your readers.')}>
                {props => <select {...props} aria-label={text('目标读者', 'Target readers')} className="stage-select" value={audience} onChange={event => form.update('targetAudience', event.target.value)}>
                  <option value="" disabled>{text('请选择', 'Choose')}</option>
                  {audience && !Object.hasOwn(AUDIENCE_EN, audience) && <option value={audience}>{audience}</option>}
                  {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => <option key={value} value={value}>{text(value, labelEn)}</option>)}
                </select>}
              </SettingField>
              <div className="writing-options-wide">
                <SettingField label={text('细分类型', 'Subgenre')} description={text('可选。用更具体的题材补充主要类型。', 'Optional. Add a more specific category to your genre.')}>
                  {props => <input {...props} aria-label={text('细分类型', 'Subgenre')} className="pi-input" placeholder={text('例如：都市悬疑、修仙、末世生存', 'e.g. urban mystery, cultivation, survival')} value={config.subGenre ?? ''} onChange={event => form.update('subGenre', event.target.value)} />}
                </SettingField>
              </div>
            </div>
            <fieldset className="writing-options-length">
              <legend>{text('篇幅计划', 'Length plan')}<span className="writing-options-required">{text('必填', 'Required')}</span></legend>
              <div className="writing-options-grid">
                <SettingField label={text('总章数', 'Total chapters')} description={text('计划全书包含多少章。', 'How many chapters you plan to write.')}>
                  {props => <div className="writing-options-number"><NumberInput id={props.id} describedBy={props['aria-describedby']} value={config.totalChapters as number | ''} fallback={100} min={1} label={text('总章数', 'Total chapters')} onChange={value => form.update('totalChapters', value as number)} /><span>{text('章', 'chapters')}</span></div>}
                </SettingField>
                <SettingField label={text('每章字数', 'Words per chapter')} description={text('AI 写作时的目标篇幅。', 'Target length for AI-generated chapters.')}>
                  {props => <div className="writing-options-number"><NumberInput id={props.id} describedBy={props['aria-describedby']} value={config.wordsPerChapter as number | ''} fallback={3000} min={100} label={text('每章字数', 'Words per chapter')} onChange={value => form.update('wordsPerChapter', value as number)} /><span>{text('字', 'words')}</span></div>}
                </SettingField>
              </div>
              <p className="writing-options-estimate" role="status">{lengthSummary}<span>{text('目标可随创作进度调整', 'You can adjust this as your story grows')}</span></p>
            </fieldset>
          </section>
          <section className="writing-options-card" aria-label={text('叙事与提醒', 'Narration and reminders')}>
            <WritingOptionsSectionHeader numeral="02" title={text('叙事与提醒', 'Narration and reminders')}
              description={text('决定故事如何讲述，及时照看未推进的伏笔。', 'Shape how the story is told and keep track of dormant threads.')} />
            <div className="writing-options-grid">
              <SettingField label={text('叙事视角', 'Point of view')} description={text('故事从谁的视角展开。', 'The perspective used to tell the story.')}>
                {props => <select {...props} aria-label={text('叙事视角', 'Point of view')} className="stage-select" value={config.narrativePOV || 'third_limited'} onChange={event => form.update('narrativePOV', event.target.value as NovelConfig['narrativePOV'])}>
                  {POV_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
                </select>}
              </SettingField>
              <SettingField label={text('故事结构', 'Story structure')} description={text('组织情节推进的整体方式。', 'The overall structure of the plot.')}>
                {props => <select {...props} aria-label={text('故事结构', 'Story structure')} className="stage-select" value={config.plotStructure || 'three_act'} onChange={event => form.update('plotStructure', event.target.value as NovelConfig['plotStructure'])}>
                  {STRUCTURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
                </select>}
              </SettingField>
            </div>
            <AdvancedPanel config={config} form={form} />
            <div className="writing-options-language"><span>{text('写作语言', 'Writing language')}</span><strong>{text('简体中文', 'Simplified Chinese')}</strong><span>{text('用于 AI 生成正文', 'Used for generated prose')}</span></div>
          </section>
          <ReferenceWorksSection content={config.referenceWorks}
            onEdit={() => openConfigField(TEXT_FIELDS.find(field => field.id === 'referenceWorks')!, projectKey)}
            onClear={() => form.update('referenceWorks', '')} />
          <aside className="writing-options-assist" aria-label={text('AI 辅助设定', 'AI setup assistance')}>
            <Sparkles size={18} className="stage-setup-spark" aria-hidden />
            <div><h2>{text('从大纲出发，补充创作设定', 'Build on your outline')}</h2>
              <p id={fillReasonId}>{fillReason ?? text('AI 将依据大纲补全设定；已有内容会先请你确认扩写。', 'AI fills in the setup from your outline and asks before expanding existing content.')}</p>
            </div>
            <Button variant="secondary" disabled={fillReason !== null || filling} aria-describedby={fillReasonId} onClick={requestFill}>
              {filling && <LoaderCircle size={15} className="stage-update-spin" aria-hidden />}
              {filling ? text('AI 正在补全…', 'AI is filling in…') : text('AI 补全其余设定', 'Fill the rest with AI')}
            </Button>
          </aside>
        </div>
      </div>

      <footer className="stage-setup-foot">
        <div className="writing-options-feedback">
          {form.saveOutcome === 'failed'
            ? <span className="stage-setup-hint" id={hintId} data-tone="danger" role="alert">{text('没能保存。设定还在这一页，没有丢，可以再保存一次。', 'Could not save. Your setup is still on this page; try saving again.')}</span>
            : <span className="stage-setup-hint" id={hintId} data-ready={missing.length === 0 || undefined} role="status">{hint}</span>}
          <span className="writing-options-save-state" role="status">{form.saving ? text('正在保存修改…', 'Saving changes…') : form.dirty ? text('有未保存的修改', 'Unsaved changes') : form.saveOutcome === 'saved' ? text('修改已保存', 'Changes saved') : text('仅用于当前作品', 'Applies to this book only')}</span>
        </div>
        <div className="writing-options-actions">
          <Button variant="secondary" disabled={!form.dirty || form.saving} onClick={() => void form.save()}>
            {form.saving ? text('正在保存…', 'Saving…') : text('保存', 'Save')}<kbd>{commandLabel('s')}</kbd>
          </Button>
          <Button variant="primary" disabled={missing.length > 0 || form.saving} aria-describedby={hintId} onClick={() => void goNext()}>
            {text('下一步：故事规划', 'Next: story planning')}
            <ArrowRight size={15} aria-hidden="true" />
          </Button>
        </div>
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
