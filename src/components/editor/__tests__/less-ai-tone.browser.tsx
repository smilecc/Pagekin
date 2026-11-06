import { useToneQueue, openToneReview } from '../../../stores/less-ai-tone-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LessAiToneButton from '../LessAiToneButton'
import { useProjectStore } from '../../../stores/project-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { chapterProject, PROJECT_PATH, SESSION } from '../../stage/chapter/__tests__/chapter-fixture'
import { createToneWorkflow } from '../../../services/less-ai-tone'
import type { ToneRun } from '../../../services/less-ai-tone'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../services/agent/writing-skill-bindings', () => ({ freezeWritingSkillsSnapshot: async () => ({}) }))
vi.mock('../../../stores/navigation/navigation-intents', () => ({ navigate: vi.fn() }))

vi.mock('../../../services/less-ai-tone', async original => ({
  ...await original<typeof import('../../../services/less-ai-tone')>(),
  createToneWorkflow: vi.fn((_session, run: ToneRun, save: (value: ToneRun) => void) => ({
    inspect: async () => save({ ...run, report: '检测报告：建议修改。' }),
    rewrite: async (approved: string) => save({ ...run, approved, revised: '修改后的文字。\n\n保留这一段。\n', comparison: '复测报告', verification: '复核完成' }),
    cancel: async () => {},
  })),
}))

let root: Root, host: HTMLDivElement
const original = '原始文字。\n\n保留这一段。\n'
const onApply = vi.fn()
const render = async (content = original, disabled = false) => act(async () => root.render(<LessAiToneButton content={content} projectKey={PROJECT_PATH} targetKey="tone-test" disabled={disabled} onApply={onApply} />))
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
const click = async (label: string) => act(async () => button(label).click())
const storageKey = `pagekin:less-ai-tone:${JSON.stringify([PROJECT_PATH, 'tone-test'])}`
const initialProject = useProjectStore.getState().currentProject
beforeEach(() => {
  useToneQueue.setState({ entries: {}, reviewKey: null }); useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {} })
  localStorage.removeItem(storageKey); onApply.mockClear(); vi.mocked(createToneWorkflow).mockClear()
  useProjectStore.setState({ currentProject: chapterProject() }); setActiveProjectSessionContext(SESSION)
  host = document.createElement('div'); host.className = 'paper-ink'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); localStorage.removeItem(storageKey)
  useProjectStore.setState({ currentProject: initialProject }); setActiveProjectSessionContext(null)
})
it('shows a direct button, waits for confirmation and applies only the human merge selection', async () => {
  await render()
  expect(button('去 AI 味')).toBeTruthy()
  await click('去 AI 味')
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('waiting')
  await act(async () => openToneReview(storageKey))
  expect(button('按建议改')).toBeTruthy()
  expect(onApply).not.toHaveBeenCalled()
  await click('按建议改')
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
  await act(async () => openToneReview(storageKey))
  expect(document.querySelector('.stage-ch-merge')).toBeTruthy()
  expect(onApply).not.toHaveBeenCalled()
  await click('全部用修稿')
  await click('完成合并')
  expect(onApply).toHaveBeenCalledWith('修改后的文字。\n\n保留这一段。\n')
  expect(localStorage.getItem(storageKey)).toBeNull()
})
it('keeps the checkpoint across closing and prevents applying after the source changes', async () => {
  await render(); await click('去 AI 味'); await click('去 AI 味'); await click('按建议改'); await click('去 AI 味')
  await click('稍后再合并'); await click('去 AI 味')
  expect(vi.mocked(createToneWorkflow)).toHaveBeenCalledTimes(2)
  await render('作者后来改了内容。')
  expect(button('完成合并').disabled).toBe(true)
  expect(document.body.textContent).toContain('原文已变化')
  expect(onApply).not.toHaveBeenCalled()
})

it('keeps running after leaving the editor and cancels from the shared queue', async () => {
  let finish!: () => void
  const cancel = vi.fn(async () => { finish() })
  vi.mocked(createToneWorkflow).mockImplementationOnce((_session, run, save) => ({
    inspect: async () => { await new Promise<void>(resolve => { finish = resolve }); save({ ...run, report: '检测报告' }) },
    rewrite: vi.fn(), cancel,
  }))
  await render(); await click('去 AI 味')
  const id = useWorkflowStore.getState().activeRuns[0].id
  expect(document.querySelector('[role=dialog]')).toBeNull()
  await act(async () => root.render(<input aria-label="其他编辑" />))
  expect(useWorkflowStore.getState().activeRuns[0].status).toBe('running')
  await act(async () => useWorkflowStore.getState().cancelWorkflow(id))
  expect(cancel).toHaveBeenCalledOnce()
  expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
  expect(useWorkflowStore.getState().history[0].status).toBe('failed')
  expect(localStorage.getItem(storageKey)).not.toBeNull()
})
