import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../stores/editor-store'
import StageSetup from '../stage/setup/StageSetup'

const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

async function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState, true)
  setActiveProjectSessionContext(null)
  vi.restoreAllMocks()
})

function project(id: string): ProjectData {
  return {
    id,
    name: `Novel ${id}`,
    path: `C:\\novels\\${id}`,
    sessionLease: `lease-${id}`,
    novelConfig: {
      genre: 'fantasy',
      subGenre: '',
      targetAudience: 'all',
      totalChapters: 100,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: `Outline ${id}`,



      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}


describe('project writing language', () => {

  it.each(['zh-CN', 'en-US'] as const)(
    'preserves custom model-generated select values in a $uiLocale interface',
    async (uiLocale) => {
      const currentProject = project(`custom-config-${uiLocale}`)
      currentProject.novelConfig.genre = 'Contemporary Romance'
      currentProject.novelConfig.targetAudience = 'Adult readers interested in realistic relationships'
      useLocaleStore.setState({ locale: uiLocale })
      useProjectStore.setState({ currentProject })
      setActiveProjectSessionContext({
        projectId: currentProject.id,
        leaseId: currentProject.sessionLease!,
        projectPath: currentProject.path,
      })

      await mount(<StageSetup projectKey={currentProject.path} />)

      const options = Array.from(document.querySelectorAll('option'))
      const genre = options.find(option => option.value === currentProject.novelConfig.genre)
      const audience = options.find(option => option.value === currentProject.novelConfig.targetAudience)
      expect({ text: genre?.textContent, selected: genre?.selected }).toEqual({
        text: 'Contemporary Romance',
        selected: true,
      })
      expect({ text: audience?.textContent, selected: audience?.selected }).toEqual({
        text: 'Adult readers interested in realistic relationships',
        selected: true,
      })
    },
  )

  it.each([
    { uiLocale: 'zh-CN', labels: ['请选择', '请选择'] },
    { uiLocale: 'en-US', labels: ['Choose', 'Choose'] },
  ] as const)('shows empty configuration placeholders in a $uiLocale interface', async ({ uiLocale, labels }) => {
    const currentProject = project(`empty-config-${uiLocale}`)
    currentProject.novelConfig.genre = ''
    currentProject.novelConfig.targetAudience = ''
    useLocaleStore.setState({ locale: uiLocale })
    useProjectStore.setState({ currentProject })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })

    await mount(<StageSetup projectKey={currentProject.path} />)

    const emptyOptions = Array.from(document.querySelectorAll<HTMLOptionElement>('option[value=""]'))
    expect(emptyOptions.map(option => option.textContent)).toEqual(labels)
    expect(emptyOptions.every(option => option.selected)).toBe(true)
    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject({
      genre: '',
      targetAudience: '',
    })
  })

  it('shows the project-scoped dormant-thread threshold with its range and bilingual labels', async () => {
    const currentProject = project('quality-setting')
    currentProject.novelConfig.narrativeThreadDormantChapterThreshold = 9
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })

    await mount(<StageSetup projectKey={currentProject.path} />)
    await expect.element(page.getByText('伏笔沉寂提醒（章）', { exact: true })).toBeVisible()
    await expect.element(page.getByText('一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 3 章。', { exact: true })).toBeVisible()
    const threshold = document.querySelector('input[aria-label="伏笔沉寂提醒（章）"]')
    if (!(threshold instanceof HTMLInputElement)) throw new Error('Missing narrative thread threshold input')
    expect({ value: threshold.value, min: threshold.min, max: threshold.max }).toEqual({ value: '9', min: '1', max: '50' })


    await act(async () => {
      useLocaleStore.setState({ locale: 'en-US' })
      root?.render(<StageSetup projectKey={currentProject.path} />)
    })
    await expect.element(page.getByText('Dormant thread reminder (chapters)', { exact: true })).toBeVisible()
    await expect.element(page.getByText('The plot page flags a thread that has not moved for this many chapters. Default 3.', { exact: true })).toBeVisible()
  })

  it('propagates configuration save failure to the exit gate', async () => {
    const currentProject = project('config-exit-failure')
    const saveProject = vi.fn(async () => { throw new Error('磁盘已满') })
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject, saveProject: saveProject as never })
    useEditorStore.setState({
      tabs: [{
        id: 'config-exit', name: '小说配置', type: 'config', projectKey: currentProject.path,
        dirty: true,
      }],
      activeTabId: 'config-exit',
      draftLedgers: {},
    })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })
    await mount(<StageSetup projectKey={currentProject.path} />)

    let failure: unknown
    await act(async () => {
      try { await saveDirtyEditorChangesForExit(currentProject.path) } catch (error) { failure = error }
    })
    expect(failure).toEqual(expect.objectContaining({ message: '磁盘已满' }))
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
    expect(container?.textContent).toContain('没能保存')
  })
})
