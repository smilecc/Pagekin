import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import ArchFileViewer from '../ArchFileViewer'
import ConfirmCard from '../../panels/agent/ConfirmCard'
import { useAgentStore } from '../../../stores/agent-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectData = {
  id: 'planning-entry', name: 'Planning entry', path: 'C:\\synthetic\\planning-entry', sessionLease: 'planning-lease',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 20, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '测试作者构想',
       globalGuidance: '', writingLanguage: 'zh-CN',
  }, characterStates: '', createdAt: '', updatedAt: '',
}
const originalProject = useProjectStore.getState()
const originalLocale = useLocaleStore.getState()
const originalAgent = useAgentStore.getState()
const originalLLM = useLLMStore.getState()
const originalWorkflow = useWorkflowStore.getState()
let invoke: ReturnType<typeof vi.fn>
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: project })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ models: [{ id: 'boundary-probe-model', purposes: ['generation'] }] as never, defaultModelId: 'boundary-probe-model' })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  invoke = vi.fn(async (channel: string) => {
      if (channel === 'config:get') return { outlineTargetUnits: 650 }
      if (channel === 'config:set') return { success: true }
      if (channel === 'generation:list' || channel === 'skills:list-user') return []
      if (channel === 'fs:check-exists') return false
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'db:project-core-get') return { worldbuilding: '世界设定'.repeat(20), totalChapters: 20 }
      if (channel === 'db:character-roster-read') return { status: 'ready', renderedMarkdown: '角色名单'.repeat(20), entries: [] }
      if (channel === 'db:blueprint-get-all') return []
      if (channel === 'fs:read-json') return { success: true, data: {} }
      if (channel === 'generation:begin') throw new Error('PLANNING_ENTRY_BOUNDARY_OBSERVED')
      throw new Error(`Unexpected IPC ${channel}`)
    })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
  } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProject)
  useLocaleStore.setState(originalLocale)
  useAgentStore.setState(originalAgent)
  useLLMStore.setState(originalLLM)
  useWorkflowStore.setState(originalWorkflow)
})

it('文档页里不足 50 字的一节点 AI 生成：标为将覆盖，不当成新生成', async () => {
  const short = '雾港的钟每晚早响一刻。'
  const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:project-core-get'
    ? { worldbuilding: short, totalChapters: 20 }
    : base(channel, ...args))
  await act(async () => root.render(<ArchFileViewer tabId="planning-world" filePath="ai-novel://core/worldbuilding" projectKey={project.path} content={short} savedContent={short} />))
  await act(async () => page.getByRole('button', { name: 'AI 生成', exact: true }).click())
  const row = await vi.waitFor(() => {
    const label = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith('世界观'))
    expect(label).toBeTruthy()
    return label!
  })
  expect(row.querySelector('[data-mark]')?.textContent).toBe('将覆盖')
})

it('文档页里写着「待生成」字样的一节与架构页一样算有内容：生成时标为将覆盖', async () => {
  const draft = '雾港的身世待生成，先记下钟楼每晚早响一刻。'
  const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:project-core-get'
    ? { worldbuilding: draft, totalChapters: 20 }
    : base(channel, ...args))
  const worldbuilding = '世界观'.repeat(20)
  await act(async () => root.render(<ArchFileViewer tabId="planning-world" filePath="ai-novel://core/worldbuilding" projectKey={project.path} content={worldbuilding} savedContent={worldbuilding} />))
  await act(async () => page.getByRole('button', { name: 'AI 重新生成', exact: true }).click())
  const row = await vi.waitFor(() => {
    const label = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith('世界观'))
    expect(label).toBeTruthy()
    return label!
  })
  expect(row.querySelector('[data-mark]')?.textContent).toBe('将覆盖')
})

it('从其他架构文档页打开生成对话框：已就绪的角色名单默认保留，不当成新生成被重写', async () => {
  const worldbuilding = '世界观'.repeat(20)
  await act(async () => root.render(<ArchFileViewer tabId="planning-world" filePath="ai-novel://core/worldbuilding" projectKey={project.path} content={worldbuilding} savedContent={worldbuilding} />))
  await act(async () => page.getByRole('button', { name: 'AI 重新生成', exact: true }).click())
  const mark = await vi.waitFor(() => {
    const row = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith('角色'))
    expect(row).toBeTruthy()
    return row!.querySelector('[data-mark]')!.getAttribute('data-mark')
  })
  expect(mark).toBe('keep')
})

it.each(['generate_architecture', 'generate_blueprint'] as const)('shows the approved %s range and target without replacing them with defaults', async workflow => {
  const resolveToolConfirmation = vi.fn()
  useAgentStore.setState({ resolveToolConfirmation })
  await act(async () => root.render(<ConfirmCard toolCall={{
    id: 'confirmed-planning', toolName: 'start_workflow', status: 'waiting_confirm',
    arguments: { workflow, start_chapter: 6, chapter_count: 10, target_units: 1000 },
  }} />))
  await expect.element(page.getByText(/范围为第 6–15 章，每章规划目标 1000 字/)).toBeVisible()
  await act(async () => page.getByRole('button', { name: '批准执行' }).click())
  expect(resolveToolConfirmation).toHaveBeenCalledWith('confirmed-planning', true)
})
