import { getActiveProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import { useEditorStore } from './editor-store'
import { openBuiltinEditor } from './open-builtin-editor'
import { useLocaleStore } from './locale-store'
import { useDraftStore } from './draft-store'
import { openDraftTab } from './open-draft-tab'
import { create } from 'zustand'
import { createToneWorkflow, type ToneRun } from '../services/less-ai-tone'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { useWorkflowStore } from './workflow-store'
import { navigate, type NavigationIntent } from './navigation/navigation-intents'

export const toneStorageKey = (project: string, target: string) => `pagekin:less-ai-tone:${JSON.stringify([project, target])}`
type Entry = { run: ToneRun; workflowId: string; session: ProjectSessionContext; origin: NavigationIntent; error?: string }
export const useToneQueue = create<{ entries: Record<string, Entry>; reviewKey: string | null }>(() => ({ entries: {}, reviewKey: null }))

export function openToneReview(key: string) {
  const entry = useToneQueue.getState().entries[key]
  if (!entry || !sameProjectSessionContext(entry.session, getActiveProjectSessionContext())) return
  useToneQueue.setState({ reviewKey: key })
  const [, target] = JSON.parse(key.slice('pagekin:less-ai-tone:'.length)) as [string, string]
  if (target.startsWith('blueprint:')) {
    navigate(entry.origin)
    openBuiltinEditor('chapter-card-editor', useLocaleStore.getState().text('故事规划', 'Story planning'), 'chapter-card', undefined, Number(target.slice(10)))
    return
  }
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(item => item.filePath === target && item.projectKey === entry.session.projectPath)
  if (tab) { editor.setActiveTab(tab.id); return }
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(item => item.filePath === target)
  if (draft) { void openDraftTab(draft, `去 AI 味 · ${draft.chapterNumber}`, entry.session); return }
  navigate(entry.origin)
}

/** Own execution outside the editor component so navigation never interrupts it. */
export function enqueueTone(key: string, value: ToneRun, session: ProjectSessionContext, origin: NavigationIntent) {
  const previous = useToneQueue.getState().entries[key]
  if (previous && useWorkflowStore.getState().activeRuns.some(run => run.id === previous.workflowId)) return
  const workflowId = crypto.randomUUID()
  const save = (run: ToneRun) => {
    localStorage.setItem(key, JSON.stringify(run))
    useToneQueue.setState(state => ({ entries: { ...state.entries, [key]: { ...state.entries[key], run } } }))
  }
  useToneQueue.setState(state => ({ entries: { ...state.entries, [key]: { run: value, workflowId, session, origin } }, reviewKey: null }))
  let client: ReturnType<typeof createToneWorkflow> | undefined
  const text = (zh: string, en: string) => useWorkflowStore.getState().activeRuns.find(run => run.id === workflowId)?.uiLocale === 'en-US' ? en : zh
  void useWorkflowStore.getState().startWorkflow({
    runId: workflowId, type: 'less_ai_tone', toneReviewKey: key,
    title: origin.kind === 'chapter' ? `去 AI 味 · ${origin.chapterNumber}` : '去 AI 味 · 故事规划',
    projectPath: session.projectPath, projectSession: session, generationModelId: value.modelId,
    onCancelRequested: async () => { await client?.cancel() },
    steps: [
      { name: '检测与建议', description: '上游检测与逐项复核', executor: async (_step, _context, callbacks) => {
        client = createToneWorkflow(session, structuredClone(useToneQueue.getState().entries[key].run), save, step => callbacks.replaceText?.(({ detect: '正在检测…', semantic: '正在逐批复核语义候选…', report: '正在整理报告…', rewrite: '正在改写…', retest: '正在复测…', verify: '正在核对…' } as Record<string, string>)[step] ?? step))
        await client.inspect()
        return useToneQueue.getState().entries[key].run.report
      } },
      { name: '按确认方案改写、复测与核对', description: '完成后由作者对比合并', requiresConfirmation: !value.approved, executor: async (_step, _context, callbacks) => {
        const run = useToneQueue.getState().entries[key].run
        client = createToneWorkflow(session, structuredClone(run), save, step => callbacks.replaceText?.(({ detect: '正在检测…', semantic: '正在逐批复核语义候选…', report: '正在整理报告…', rewrite: '正在改写…', retest: '正在复测…', verify: '正在核对…' } as Record<string, string>)[step] ?? step))
        await client.rewrite(run.approved ?? '按建议改')
        return text('已完成，请打开对比审查并手动合并。', 'Complete. Open the comparison to review and merge.')
      } },
    ],
  }).then(() => {
    const result = useWorkflowStore.getState().history.find(run => run.id === workflowId)
    if (result?.error) useToneQueue.setState(state => ({ entries: { ...state.entries, [key]: { ...state.entries[key], error: result.error } } }))
  })
}

export function approveTone(key: string, guidance: string) {
  const entry = useToneQueue.getState().entries[key]
  if (!entry || !sameProjectSessionContext(entry.session, getActiveProjectSessionContext())) return
  const run = { ...entry.run, approved: entry.run.approved ?? (guidance.trim() || '按建议改') }
  localStorage.setItem(key, JSON.stringify(run))
  useToneQueue.setState(state => ({ entries: { ...state.entries, [key]: { ...entry, run } }, reviewKey: null }))
  useWorkflowStore.getState().confirmContinue(entry.workflowId)
  navigate({ kind: 'run', facet: 'output', runId: entry.workflowId })
}
