import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { page } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { EMPTY_CARD, useCharacterStore } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageArchitecture from '../StageArchitecture'
import StageSetup from '../../setup/StageSetup'
import StageWorkspace from '../../StageWorkspace'
import StageSpine from '../../StageSpine'
import { useStageView } from '../../use-stage-work'
import { openPageTab } from '../../../../stores/navigation/page-tabs'
import { deriveStages, locate } from '../../../../stores/navigation/stage-progress'
import { discardAndCloseEditorTab } from '../../../../stores/editor-discard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const PREMISE = '收到匿名信的林舟登上一座本该拆除的车站的末班车，发现每盏阅读灯都对应一个失踪者。'.repeat(2)

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let core: Record<string, unknown>
let partial: Record<string, unknown> | null
let rosterStatus: 'empty' | 'ready'
let recoveryContext: Record<string, unknown> | null
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
/** 启动的工作流只含勾选的那几节，步骤 key 就是实际交给后台的节。 */
let started: ReturnType<typeof vi.fn<(definition: { steps: { key: string }[] }) => Promise<string>>>
const launchedSteps = () => started.mock.calls.map(([definition]) => definition.steps.map(step => step.key))




async function render() {
  await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading], .arch-page[data-cast-loading]')).toBeNull())
}

beforeEach(() => {
  core = { premise: PREMISE, worldbuilding: '', synopsis: '', totalChapters: 24, writingLanguage: 'zh-CN' }
  partial = null
  recoveryContext = null
  rosterStatus = 'empty'
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:project-core-get') return core
    if (channel === 'fs:read-json') return partial ? { success: true, data: partial } : { success: false, error: 'not found' }
    if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: rosterStatus, entries: [], renderedMarkdown: '林舟、沈砚', projectionHash: 'p', factHash: 'f' }
    if (channel === 'generation:list') return []
    if (channel === 'generation:read-context') return recoveryContext
    if (channel === 'generation:read-visible-composition') return null
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'db:project-core-update') {
      Object.assign(core, args[0] as Record<string, unknown>)
      return { success: true }
    }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: {
    id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车',
    novelConfig: { totalChapters: 24, wordsPerChapter: 3000, genre: '悬疑', targetAudience: '成人', coreOutline: '末班车', writingLanguage: 'zh-CN' },
  } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  started = vi.fn(async () => 'r1')
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [], startWorkflow: started as never })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useCharacterStore.setState({ characters: [{ ...EMPTY_CARD, characterId: 'c1', name: '林舟' }, { ...EMPTY_CARD, characterId: 'c2', name: '沈砚' }],
    dataProjectKey: session.projectPath, loadingProjectKey: null, lastError: null })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1100px; height: 900px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})


describe('合并后的架构页面', () => {
  it('架构仅保留参考作品与基本选项，移出的项目不再重复展示', async () => {
    await act(async () => root!.render(<StageSetup projectKey={session.projectPath} />))
    expect(host!.querySelectorAll('.arch-section')).toHaveLength(1)
    expect(host!.querySelector('.arch-section')?.getAttribute('data-section')).toBe('referenceWorks')
    for (const id of ['coreOutline', 'worldbuilding', 'characters', 'writingStyle', 'globalGuidance', 'premise', 'goldenFinger']) expect(host!.querySelector(`[data-section="${id}"]`)).toBeNull()
    expect(host!.textContent).not.toContain('更多设定')
    expect(host!.textContent).not.toContain('恢复默认')
    expect(host!.querySelectorAll('.stage-setup-option')).toHaveLength(7)
    expect([...host!.querySelectorAll('.stage-setup-basics')].map(section => section.getAttribute('aria-label'))).toEqual(['基本信息', '叙事与提醒', '参考作品'])
    expect(host!.querySelector('h1')?.textContent).toBe('写作选项')
  })

  it('创作流程按顺序显示五个独立入口，并正确定位独立标签', async () => {
    const stages = deriveStages({ config: useProjectStore.getState().currentProject!.novelConfig, architecture: { worldbuilding: false, characters: true }, blueprints: [], drafts: {}, runningChapters: new Set() })
    function ConnectedSpine() {
      const { location } = useStageView()
      return <StageSpine stages={stages} chapters={[]} location={location} onStage={openPageTab} onChapter={() => {}} onResource={() => {}} onSettings={() => {}} />
    }
    await act(async () => root!.render(<ConnectedSpine />))
    expect(host!.textContent).not.toContain('待填写')
    expect(host!.textContent).not.toContain('已填写')
    expect(host!.querySelector('[data-stage="architecture"] .stage-row-meta')).toBeNull()
    expect(host!.querySelector('[data-stage="architecture"] .stage-mark')).toBeNull()
    const highlighted = () => [...host!.querySelectorAll('.stage-stages [aria-current="page"]')].map(item => item.getAttribute('data-stage'))
    expect([...host!.querySelectorAll('.stage-stages .stage-row-name')].map(item => item.textContent)).toEqual(['大纲', '世界观', '角色名单', '文风', '全局写作要求', '写作选项', '故事规划', '正文'])
    for (const [stage, field] of [['outline', 'coreOutline'], ['style', 'writingStyle'], ['guidance', 'globalGuidance']] as const) {
      await act(async () => host!.querySelector<HTMLButtonElement>(`[data-stage="${stage}"]`)!.click())
      const tab = useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId)!
      expect(tab.configField).toBe(field)
      expect(locate(tab)).toEqual({ kind: 'stage', stage })
      expect(highlighted()).toEqual([stage])
    }
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-stage="world"]')!.click())
    await vi.waitFor(() => expect(locate(useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId))).toEqual({ kind: 'stage', stage: 'world' }))
    await vi.waitFor(() => expect(highlighted()).toEqual(['world']))
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-stage="cast"]')!.click())
    expect(locate(useEditorStore.getState().tabs.find(item => item.id === useEditorStore.getState().activeTabId))).toEqual({ kind: 'stage', stage: 'cast' })
    expect(highlighted()).toEqual(['cast'])
    await act(async () => openPageTab('architecture'))
    expect(highlighted()).toEqual(['architecture'])
    await act(async () => openPageTab('outline'))
    expect(highlighted()).toEqual(['outline'])
  })

  it('长文本打开真实标签，切换保持输入，关闭一项只放弃该项', async () => {
    const save = vi.fn(async () => true)
    useProjectStore.setState({ saveProject: save })
    useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
    useEditorStore.getState().openFile({ id: 'config', name: '写作选项', type: 'config', projectKey: session.projectPath })
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await act(async () => openPageTab('outline'))
    await expect.element(page.getByRole('tab', { name: '大纲', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(host!.querySelector('.stage-setup-basics')).toBeNull()
    await act(async () => page.getByRole('textbox').fill('末班车上的每个人都在寻找同一封信。'))
    await act(async () => page.getByRole('tab', { name: '写作选项', exact: true }).click())
    await act(async () => openPageTab('style'))
    await act(async () => page.getByRole('textbox').fill('简洁克制'))
    await act(async () => page.getByRole('tab', { name: '写作选项', exact: true }).click())
    await click('编辑参考作品')
    await act(async () => page.getByRole('textbox').fill('参考作品的叙述节奏'))
    await act(async () => page.getByRole('tab', { name: '文风', exact: true }).click())
    expect(host!.querySelector('.cm-content')?.textContent).toBe('简洁克制')
    const tabs = useEditorStore.getState().tabs
    expect(tabs.filter(tab => tab.configField)).toHaveLength(3)
    await act(async () => discardAndCloseEditorTab(tabs.find(tab => tab.configField === 'referenceWorks')!.id, session))
    expect(useProjectStore.getState().currentProject?.novelConfig.referenceWorks).toBeUndefined()
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('简洁克制')
    expect(useProjectStore.getState().currentProject?.novelConfig.coreOutline).toContain('每个人都在寻找')
    await act(async () => page.getByRole('button', { name: '保存', exact: true }).click())
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    await act(async () => page.getByRole('tab', { name: '写作选项', exact: true }).click())
    await act(async () => openPageTab('style'))
    expect(useEditorStore.getState().tabs.filter(tab => tab.configField === 'writingStyle')).toHaveLength(1)
  })

  it('生成架构全选只包含角色与世界观', async () => {
    await render()
    await click('AI 生成架构')
    expect(document.querySelector('[data-step="synopsis"]')).toBeNull()
    const selectAll = document.querySelector<HTMLInputElement>('.arch-step-all input')!
    if (!selectAll.checked) await act(async () => selectAll.click())
    await click('开始生成 2 项')
    await vi.waitFor(() => expect(launchedSteps()).toEqual([['characters', 'adopt-characters', 'worldbuilding']]))
  })
})
