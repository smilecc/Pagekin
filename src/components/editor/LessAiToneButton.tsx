import { useLayoutEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { getActiveProjectSessionContext, projectSessionContextFromProject, sameProjectPathKey } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { newToneRun, type ToneRun } from '../../services/less-ai-tone'
import { routeModelId } from '../../services/model-routing'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useToneQueue, enqueueTone, approveTone } from '../../stores/less-ai-tone-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { Button } from '../ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/Dialog'
import { Notice } from '../ui/Notice'
import MarkdownContent from '../ui/MarkdownContent'
import MergeView from '../stage/chapter/MergeView'
import './less-ai-tone.css'

/** Both surfaces share the upstream workflow and the existing human merge controls. */
export default function LessAiToneButton({ content, targetKey, projectKey, chapterNumber, disabled = false, onApply }: {
  content: string
  targetKey: string
  projectKey: string
  chapterNumber?: number
  disabled?: boolean
  onApply: (content: string) => void
}) {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const [localSessionKey, setSessionKey] = useState('')
  const [localOpen, setLocalOpen] = useState(false)
  const [localRun, setRun] = useState<ToneRun | null>(null)
  const [localError, setError] = useState('')
  const [guidance, setGuidance] = useState('')
  const session = useRef<ProjectSessionContext | null>(null)
  const latest = useRef({ content, disabled, onApply })
  useLayoutEffect(() => { latest.current = { content, disabled, onApply } }, [content, disabled, onApply])
  const storageKey = `pagekin:less-ai-tone:${JSON.stringify([projectKey, targetKey])}`
  const entry = useToneQueue(state => state.entries[storageKey])
  const reviewKey = useToneQueue(state => state.reviewKey)
  const queued = useWorkflowStore(state => state.activeRuns.find(item => item.id === entry?.workflowId))
  const busy = Boolean(queued && queued.status !== 'waiting')
  const run = entry?.run ?? localRun
  const error = localError || entry?.error || ''
  const sessionKey = entry ? JSON.stringify(entry.session) : localSessionKey
  const open = localOpen || reviewKey === storageKey
  const setOpen = (value: boolean) => { setLocalOpen(value); if (!value && reviewKey === storageKey) useToneQueue.setState({ reviewKey: null }) }
  const current = () => JSON.stringify(entry?.session ?? session.current) === JSON.stringify(getActiveProjectSessionContext())
  const execute = (value: ToneRun, approve = false) => {
    const activeSession = entry?.session ?? session.current
    if (!activeSession || !current()) return
    setOpen(false); setError('')
    if (approve && queued?.status === 'waiting') { approveTone(storageKey, guidance); return }
    enqueueTone(storageKey, approve ? { ...value, approved: value.approved ?? (guidance.trim() || '按建议改') } : value, activeSession,
      chapterNumber === undefined ? { kind: 'stage', stage: 'blueprint' } : { kind: 'chapter', chapterNumber })
  }
  const start = () => {
    const active = getActiveProjectSessionContext()
    if (!active || !sameProjectPathKey(active.projectPath, projectKey)) return
    session.current = active
    setSessionKey(JSON.stringify(active))
    setError('')
    if (queued && queued.status !== 'waiting') { navigate({ kind: 'run', facet: 'output', runId: queued.id }); return }
    if (run) { setOpen(true); return }
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const value = JSON.parse(saved) as ToneRun
        if (value.version === 1 && typeof value.source === 'string' && value.outputs && value.nonces) { setRun(value); setOpen(true); return }
      }
    } catch { /* Invalid checkpoints are replaced by a new run. */ }
    localStorage.removeItem(storageKey)
    const value = newToneRun(latest.current.content, useProjectStore.getState().currentProject?.novelConfig.writingStyle ?? '', routeModelId('less-ai-tone') ?? '')
    localStorage.setItem(storageKey, JSON.stringify(value))
    setRun(value)
    void execute(value)
  }
  const restart = () => {
    if (queued) return
    localStorage.removeItem(storageKey)
    const value = newToneRun(latest.current.content, useProjectStore.getState().currentProject?.novelConfig.writingStyle ?? '', routeModelId('less-ai-tone') ?? '')
    localStorage.setItem(storageKey, JSON.stringify(value))
    setRun(value); setGuidance(''); void execute(value)
  }
  const apply = async (merged: string) => {
    if (!run || !current() || latest.current.disabled || latest.current.content !== run.source) {
      setError(text('原文或目标已变化，请重新检测后再合并。', 'The source or target changed. Run detection again before merging.'))
      return false
    }
    latest.current.onApply(merged)
    localStorage.removeItem(storageKey)
    useToneQueue.setState(state => { const entries = { ...state.entries }; delete entries[storageKey]; return { entries } })
    setRun(null); setOpen(false)
    return true
  }
  const download = () => {
    if (!run) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'less-ai-tone-report.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const sessionCurrent = sessionKey === JSON.stringify(projectSessionContextFromProject(project))
  const stale = Boolean(run && (run.source !== content || !sessionCurrent))
  return <>
    <Button variant="secondary" size="sm" disabled={disabled || !content.trim()} onClick={start}>
      <Sparkles size={15} aria-hidden />{text('去 AI 味', 'Remove AI tone')}
    </Button>
    <Dialog modal={false} open={open} onOpenChange={setOpen}>
      <DialogContent className="tone-dialog" onPointerDownOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{text('去 AI 味', 'Remove AI tone')}</DialogTitle>
          <DialogDescription>{text('检测与建议 → 确认改写 → 复测 → 对比合并。合并后沿用页面的保存操作。', 'Findings → Approve rewrite → Retest → Compare and merge. Save the merged text from the page.')}</DialogDescription>
        </DialogHeader>
        <div className="tone-body">
          {busy && <p role="status">{text('正在后台运行，可关闭此窗口继续编辑。', 'Running in the background. Close this window to keep editing.')}</p>}
          {error && <Notice tone="warn" title={error} />}
          {error && run?.failures?.length ? <details>
            <summary>{text('查看失败原文', 'Inspect failed response')}</summary>
            <pre className="tone-failure-output">{run.failures.at(-1)?.output}</pre>
          </details> : null}
          {stale && <Notice tone="warn" title={text('原文已变化，这份结果仅供查看。', 'The source changed. This result is view-only.')} />}
          {run?.report && <details open={!run.verification}>
            <summary>{text('检测报告与建议', 'Findings and recommendations')}</summary>
            <MarkdownContent content={run.report} />
          </details>}
          {run?.report && !run.approved && !busy && <label className="pi-field">
            <span>{text('对方案的调整（可选）', 'Adjust the recommendations (optional)')}</span>
            <textarea className="pi-input" rows={3} value={guidance} onChange={event => setGuidance(event.target.value)} />
          </label>}
          {run?.comparison && <details><summary>{text('脚本复测与前后报告', 'Script retest and comparison report')}</summary><MarkdownContent content={run.comparison} /></details>}
          {run?.verification && <>
            <details open><summary>{text('改后核对', 'Post-rewrite verification')}</summary><MarkdownContent content={run.verification} /></details>
            <MergeView key={run.nonce} preserveFormatting recheck={false} versionLabel={text('检测时原文', 'Source at detection')}
              data={{ originalContent: run.source, modifiedContent: run.revised!, revisionPath: '', targetSnapshot: { content: run.source, contentRevision: 0 }, staleReason: stale || disabled ? text('原文或编辑状态已变化，请重新检测。', 'The source or edit state changed. Run detection again.') : null }}
              onComplete={apply} onLater={() => setOpen(false)} />
          </>}
          <p className="tone-attribution"><a href="https://github.com/larashero3-dotcom/lieflat-less-ai-tone" target="_blank" rel="noreferrer">Lieflat Less AI Tone</a> · shiujan · CC BY-NC 4.0</p>
        </div>
        <div className="pi-dialog-foot">
          <Button variant="text" onClick={() => setOpen(false)}>{text('关闭', 'Close')}</Button>
          {run && <Button variant="text" onClick={download}>{text('导出完整记录', 'Export full record')}</Button>}
          {!queued && run && <Button variant="secondary" disabled={disabled || !sessionCurrent} onClick={restart}>{text('重新检测当前原文', 'Detect current source again')}</Button>}
          {!busy && run && !run.verification && <Button variant="primary" disabled={stale || disabled} onClick={() => void execute(run, Boolean(run.report))}>
            {run.report ? run.approved ? text('继续改写与复测', 'Continue rewrite and retest') : text('按建议改', 'Rewrite as recommended') : text('继续检测', 'Continue detection')}
          </Button>}
          {queued && <Button variant="secondary" onClick={() => { setOpen(false); navigate({ kind: 'run', facet: 'output', runId: queued.id }) }}>{text('查看运行', 'View run')}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>
}
