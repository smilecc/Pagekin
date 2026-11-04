import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { disposeProjectService, initProjectService } from '../../../../services/project-service'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { editorSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageBlueprint from '../StageBlueprint'

const PROJECT_PATH = 'C:\\novels\\stage-blueprint'
const SESSION = { projectId: 'stage-blueprint', leaseId: 'stage-blueprint-lease', projectPath: PROJECT_PATH }
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let stored: ChapterBlueprint[]
let nextChapter: number
let projectCore: { premise: string } | null
let invoke: ReturnType<typeof vi.fn>

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber, title, role: '发展', purpose: '推进灯塔线索', keyEvents: '钟声提前一刻', characters: ['林岚', '守塔人'],
    suspenseHook: '', userGuidance: chapterNumber === 2 ? '节奏放慢。' : '', notes: '', notesUpdatedAt: '',
  }
}

function project(): ProjectData {
  return {
    id: 'stage-blueprint', sessionLease: 'stage-blueprint-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔',    globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return stored
    if (channel === 'db:draft-authority-sequence') return {
      status: 'continuous', lastChapterNumber: nextChapter - 1, nextChapterNumber: nextChapter, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64),
    }
    if (channel === 'generation:find-blueprint-recovery') return null
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'db:blueprint-clear-all') {
      stored = []
      return { success: true }
    }
    if (channel === 'db:blueprint-delete') {
      stored = stored.filter(item => item.chapterNumber !== args[0])
      return { success: true }
    }
    if (channel === 'db:blueprint-upsert' || channel === 'db:blueprint-upsert-many') return { success: true }
    if (channel === 'fs:list-dir') return []
    if (channel === 'config:get') return { blueprintTargetUnits: 800 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'db:project-core-get') return projectCore
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    if (channel === 'db:character-roster-read') return { status: 'ready', entries: [{ name: '林岚' }, { name: '顾舟' }, { name: '守塔人' }] }
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

async function renderPage(initialChapterNumber?: number) {
  await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={initialChapterNumber} /></div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
}

/** 后台生成提交一段故事规划、定稿、删除或清空之后，故事规划页都会收到这条刷新。 */
async function refreshBlueprints() {
  const before = calls('db:blueprint-get-all').length
  await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'], projectPath: PROJECT_PATH,
    projectSession: SESSION }))
  await vi.waitFor(() => expect(calls('db:blueprint-get-all').length).toBeGreaterThan(before))
  await vi.waitFor(() => expect(calls('db:draft-authority-sequence').length).toBe(calls('db:blueprint-get-all').length))
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  // 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([1280, 900]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  stored = [blueprint(1, '旧港'), blueprint(2, '北堤'), blueprint(3, '灯室')]
  nextChapter = 2
  projectCore = null
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project() })
  useStageStore.setState({ writeRequest: null, work: null })
  setActiveProjectSessionContext(SESSION)
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditor)
  useProjectStore.setState(originalProject)
  useStageStore.setState(originalStage)
})

describe('故事规划阶段', () => {
  it('打开故事规划页只向主进程要一次故事规划恢复稿，不逐个读取生成运行（#536）', async () => {
    await renderPage()
    await vi.waitFor(() => expect(calls('generation:find-blueprint-recovery')).toHaveLength(1))
    expect([...calls('generation:list'), ...calls('generation:read-context')]).toEqual([])
  })
  it('规划页以 AI 生成和新建章节为主，不混入正文写作状态与按钮', async () => {
    await renderPage()
    expect(page.getByRole('button', { name: 'AI 生成故事规划' }).element().className).toContain('pi-btn--primary')
    await expect.element(page.getByRole('button', { name: '新建章节' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).query()).toBeNull()
    expect(container!.querySelector('.stage-bp-card')!.textContent).not.toContain('正文 · 待写')
    expect(container!.querySelector('.cm-lp-dropcap-char')).toBeNull()
    const content = container!.querySelector('.cm-content')!
    expect(getComputedStyle(content).paddingLeft).toBe('0px')
    expect(getComputedStyle(content).paddingRight).toBe('0px')
  })

  it('英文界面里只有一章故事规划时写 1 chapter，不写 1 chapters', async () => {
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    expect(document.querySelector('.stage-bp-plan-top')?.textContent).toBe('1 chapter')
  })

  it('清空全部故事规划在危险分组里，确认前不清空，确认后列表为空并出现空状态', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多故事规划操作' }).click())
    const dangerGroup = page.getByRole('group', { name: '危险' })
    await act(async () => dangerGroup.getByRole('menuitem', { name: '清空全部故事规划…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空全部故事规划？' })
    await expect.element(confirm).toHaveTextContent('将删除全部 3 章故事规划')
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)

    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)
    await expect.element(page.getByRole('button', { name: /^1\D/ })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '更多故事规划操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清空全部故事规划…' }).click())
    await act(async () => page.getByRole('dialog', { name: '清空全部故事规划？' }).getByRole('button', { name: '清空全部' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
    await expect.element(page.getByRole('heading', { name: '还没有故事规划' })).toBeVisible()
    expect(page.getByRole('complementary', { name: '章节规划' }).query()).toBeNull()
  })

  it('删除此章在单章的危险分组里，确认后只删这一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    const confirm = page.getByRole('dialog', { name: '删除第 3 章故事规划？' })
    await expect.element(confirm).toBeVisible()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
    await expect.element(page.getByRole('button', { name: /^3\D/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /^2\D/ })).toBeVisible()
  })

  it('改字段后由外壳的保存（⌘S 同一入口）存全部，页面里不另显示未保存', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('北堤夜雨'))
    await act(async () => page.getByRole('textbox').last().fill('节奏放慢，只写声音。'))
    expect(container?.textContent).not.toContain('未保存')

    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(save).not.toBeNull()
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).find(item => item.chapterNumber === 2)).toMatchObject({ title: '北堤夜雨', keyEvents: '节奏放慢，只写声音。' })
  })

  it('保存此章只写当前一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-upsert').map(call => call[1])).toMatchObject([{ chapterNumber: 1, title: '旧港潮汐' }]))
  })

  it('保存此章、删除此章、清空故事规划之后项目树不重读目录：故事规划只在数据库里', async () => {
    initProjectService()
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-upsert')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
      await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
      await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
      await act(async () => page.getByRole('dialog', { name: '删除第 3 章故事规划？' }).getByRole('button', { name: '删除此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-delete')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: '更多故事规划操作' }).click())
      await act(async () => page.getByRole('menuitem', { name: '清空全部故事规划…' }).click())
      await act(async () => page.getByRole('dialog', { name: '清空全部故事规划？' }).getByRole('button', { name: '清空全部' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
      expect(calls('fs:list-dir')).toEqual([])
    } finally {
      disposeProjectService()
    }
  })

  it('保存此章与保存全部成功后通知流程脊、Ctrl P 重读故事规划；保存失败不通知', async () => {
    const refreshes: string[][] = []
    const off = globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => { refreshes.push([...resources]) })
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(refreshes).toEqual([['blueprints']]))

      const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
      await act(async () => { await save!() })
      expect(refreshes).toEqual([['blueprints'], ['blueprints']])

      const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:blueprint-upsert'
        ? { success: false, error: '磁盘已满' } : base(channel, ...args))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(refreshes).toHaveLength(2)
    } finally {
      off()
    }
  })

  it('保存此章与开始生成进行中时按钮带 aria-busy，结束后撤掉', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, coreOutline: '' } } })
    await renderPage()
    const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const gates = new Map<string, () => void>()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-upsert' || channel === 'config:set') await new Promise<void>(resolve => gates.set(channel, resolve))
      return base(channel, ...args)
    })
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    const saving = page.getByRole('button', { name: '保存中…' })
    await expect.element(saving).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('db:blueprint-upsert')!())
    await expect.element(page.getByRole('button', { name: '保存此章' })).not.toHaveAttribute('aria-busy')

    await act(async () => page.getByRole('button', { name: 'AI 生成故事规划' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成故事规划' })
    await act(async () => dialog.getByLabelText('故事规划起始章').fill('5'))
    await act(async () => dialog.getByLabelText('故事规划结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await vi.waitFor(() => expect(gates.has('config:set')).toBe(true))
    await expect.element(dialog.getByRole('button', { name: '启动中…' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('config:set')!())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).not.toHaveAttribute('aria-busy')
  })

  it('英文界面里作品只有一章时生成范围写 All 1 chapter', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, totalChapters: 1 } } })
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => page.getByRole('button', { name: 'Generate blueprints' }).click())
    const full = await vi.waitFor(() => [...document.querySelectorAll('[role="dialog"] .stage-bp-option')].find(option => option.textContent?.startsWith('All'))!)
    expect(full.textContent).toBe('All 1 chapter')
  })

  it('章节规划保留标题、角色与正文编辑器，换章后保留各自的未保存内容', async () => {
    await renderPage()
    expect(container!.querySelectorAll('.stage-bp-card input')).toHaveLength(2)
    expect(container!.querySelectorAll('.stage-bp-card textarea, .stage-bp-card select')).toHaveLength(0)
    expect(container!.querySelector('.stage-bp-card .cm-editor')).not.toBeNull()
    await act(async () => page.getByRole('textbox').last().fill('第一章的自由规划'))
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('textbox').last().fill('第二章的自由规划'))
    await act(async () => page.getByRole('button', { name: /^1\D/ }).click())
    expect(container!.querySelector('.cm-content')?.textContent).toBe('第一章的自由规划')
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).filter(item => item.chapterNumber <= 2).map(item => item.keyEvents)).toEqual(['第一章的自由规划', '第二章的自由规划'])
  })

  it('生成故事规划选覆盖时先危险确认，取消后不启动，生成对话框回来且不当作错误', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成故事规划' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成故事规划' })
    await expect.element(dialog).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有故事规划会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const confirm = page.getByRole('dialog', { name: '覆盖已有故事规划？' })
    await expect.element(confirm).toHaveTextContent('已有的 3 章故事规划会被新故事规划替换')
    expect(calls('db:project-core-get')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).toBeVisible()
    expect(dialog.getByRole('alert').query()).toBeNull()
    expect(calls('db:project-core-get')).toHaveLength(0)
  })

  it('指定范围只补没有故事规划的章，不出现覆盖选项与覆盖提示', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成故事规划' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成故事规划' })
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有故事规划会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByLabelText('故事规划起始章').fill('5'))
    await expect.element(dialog.getByText('已有故事规划会被覆盖，开始前再确认一次')).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '覆盖' }).query()).toBeNull()
  })

  it('指定范围后取消架构警告：对话框回来，作者填的起止章还在，不当作错误', async () => {
    projectCore = { premise: '灯塔'.repeat(40) }
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成故事规划' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成故事规划' })
    await act(async () => dialog.getByLabelText('故事规划起始章').fill('5'))
    await act(async () => dialog.getByLabelText('故事规划结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const warning = page.getByRole('dialog', { name: '架构还不完整' })
    await expect.element(warning).toBeVisible()
    await act(async () => warning.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByLabelText('故事规划起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('故事规划结束章')).toHaveValue(7)
    expect(dialog.getByRole('alert').query()).toBeNull()
  })

  it('指定范围后启动失败：对话框回来写明原因，作者填的起止章还在', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, coreOutline: '' } } })
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成故事规划' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成故事规划' })
    await act(async () => dialog.getByLabelText('故事规划起始章').fill('5'))
    await act(async () => dialog.getByLabelText('故事规划结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await expect.element(dialog.getByRole('alert')).toHaveTextContent('请先填写「大纲」')
    await expect.element(dialog.getByLabelText('故事规划起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('故事规划结束章')).toHaveValue(7)
  })

  it('批量创作对话框从权威下一章开始，按章数显示主按钮', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多故事规划操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '批量创作…' }).click())
    const dialog = page.getByRole('dialog', { name: '批量创作' })
    await expect.element(dialog.getByText('第 2 章', { exact: true })).toBeVisible()
    await act(async () => dialog.getByLabelText(/写几章/).fill('4'))
    await expect.element(dialog.getByRole('button', { name: '开始写 4 章' })).toBeVisible()
    await act(async () => dialog.getByRole('radio', { name: /自动定稿/ }).click())
    await expect.element(dialog.getByRole('button', { name: '继续确认自动定稿' })).toBeVisible()
  })

  it('「写几章」清空后重新输入：删掉 1 再输 3 得 3，不是 13；空着离开回到 1', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多故事规划操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '批量创作…' }).click())
    const count = page.getByRole('dialog', { name: '批量创作' }).getByLabelText(/写几章/)
    const input = count.element() as HTMLInputElement
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('3')
    expect(input.value).toBe('3')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('1')
  })

  it('直接新建章节：新章接在权威下一章已有故事规划之后并被选中', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '新建章节' }).click())
    await expect.element(page.getByRole('button', { name: /^4\D/ })).toHaveAttribute('aria-current', 'true')
    await expect.element(page.getByRole('region', { name: '第 4 章故事规划' })).toBeVisible()
  })

  it('规划页不消耗交给单章视图的正文写作请求', async () => {
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } })
    await renderPage()
    expect(useStageStore.getState().writeRequest).toEqual({ session: SESSION, chapterNumber: 2 })
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('保存出场角色并在换章和重新加载时保留未保存修改', async () => {
    await renderPage()
    await act(async () => page.getByRole('combobox', { name: '出场角色' }).fill('顾舟、林岚'))
    await act(async () => userEvent.keyboard('{Enter}'))
    await act(async () => page.getByRole('button', { name: '移除出场角色 守塔人' }).click())
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('button', { name: /^1\D/ }).click())
    await refreshBlueprints()
    expect(container!.querySelector('.stage-bp-people')?.textContent).toContain('顾舟')
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    expect(calls('db:blueprint-upsert').at(-1)?.[1]).toMatchObject({ characters: ['林岚', '顾舟'] })
  })

  it('角色输入框中的姓名在保存快捷键到达外壳前进入保存数据', async () => {
    await renderPage()
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })!
    const onSaveKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 's') { event.preventDefault(); void save() }
    }
    window.addEventListener('keydown', onSaveKey)
    try {
      await act(async () => page.getByRole('combobox', { name: '出场角色' }).fill('顾舟'))
      await act(async () => userEvent.keyboard('{Control>}s{/Control}'))
      await vi.waitFor(() => expect(calls('db:blueprint-upsert-many')).toHaveLength(1))
      expect((calls('db:blueprint-upsert-many')[0][1] as ChapterBlueprint[])[0].characters).toEqual(['林岚', '守塔人', '顾舟'])
    } finally {
      window.removeEventListener('keydown', onSaveKey)
    }
  })

  it('删除确认期间故事规划重新加载：确认框仍是作者选的那一章，删的也是它，选中不跳回', async () => {
    await renderPage(2)
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章故事规划？' })).toBeVisible()
    await refreshBlueprints()
    // 确认框是模态的，页面其余部分对辅助技术隐藏，直接读选中的那一行。
    expect(container?.querySelector('.stage-bp-plan-item[aria-current] .stage-bp-plan-no')?.textContent).toBe('3')
    const confirm = page.getByRole('dialog', { name: /^删除第 \d+ 章故事规划？$/ })
    await expect.element(confirm).toHaveAccessibleName('删除第 3 章故事规划？')
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
  })

  it('删除确认期间这一章已被别处删掉：确认后不会改删别的章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    stored = stored.filter(item => item.chapterNumber !== 3)
    await refreshBlueprints()
    const confirm = page.getByRole('dialog', { name: '删除第 3 章故事规划？' })
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await expect.element(confirm).not.toBeInTheDocument()
    expect(calls('db:blueprint-delete')).toEqual([])
  })

  it('窄窗口下规划正文保持正常字号与紧凑边距', async () => {
    await page.viewport(680, 900)
    await renderPage()
    const card = container!.querySelector('.stage-bp-card')!
    const content = container!.querySelector('.cm-content')!
    expect(card.getBoundingClientRect().width).toBeGreaterThan(300)
    expect(parseFloat(getComputedStyle(content).paddingLeft)).toBe(0)
    expect(container!.querySelector('.cm-lp-dropcap-char')).toBeNull()
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
  })
})
