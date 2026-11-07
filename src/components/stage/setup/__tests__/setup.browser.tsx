/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { page, userEvent } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'

import type { NovelConfig, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { IS_MAC } from '../../shortcut-keys'
import { useStageShortcuts } from '../../use-stage-shortcuts'
import StageSetup from '../StageSetup'
import '../../../../index.css'

const COMMAND = IS_MAC ? { metaKey: true } : { ctrlKey: true }

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useProjectStore), snapshot(useLLMStore), snapshot(useEditorStore), snapshot(useWorkflowStore), snapshot(useLocaleStore)]

const PATH = 'C:\\novels\\island'
const SESSION = { projectId: 'island', leaseId: 'lease-1', projectPath: PATH }
const BLANK: Partial<NovelConfig> = {
  coreOutline: '', genre: '', subGenre: '', targetAudience: '', totalChapters: 24, wordsPerChapter: 3000,
     globalGuidance: '', writingStyle: '', referenceWorks: '',
  narrativePOV: 'third_limited', plotStructure: 'three_act', writingLanguage: 'zh-CN',
}

let root: Root | undefined
let host: HTMLDivElement | undefined

function project(config: Partial<NovelConfig>) {
  setActiveProjectSessionContext(SESSION)
  useProjectStore.setState({ currentProject: { id: 'island', sessionLease: 'lease-1', name: '雾岛', path: PATH, novelConfig: { ...BLANK, ...config } } as unknown as ProjectData })
}

function Shortcuts() {
  useStageShortcuts({ library: false, focus: false })
  return null
}

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<><Shortcuts /><StageSetup projectKey={PATH} /></>))
}

const alertText = () => [...host!.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' | ')
const dirtyConfigTab = () => useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: PATH, dirty: true }] as never, activeTabId: 'config' })
const SAVE_FAILED = '没能保存。设定还在这一页，没有丢，可以再保存一次。'

const byName = (name: string | RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => {
    const label = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })
const next = () => byName(/^下一步：故事规划/)!
const hint = () => host!.querySelector('.stage-setup-foot [role="status"]')!.textContent
const field = (label: RegExp) => [...host!.querySelectorAll<HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement>('select, textarea, input')]
  .find(control => label.test(control.getAttribute('aria-label') ?? control.labels?.[0]?.textContent ?? ''))!

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function write(textarea: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  useWorkflowStore.setState({ startWorkflow: vi.fn(async () => undefined), getResourceConflict: () => null } as never)
  useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({ saveProject: vi.fn(async () => true) } as never)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('设定页', () => {
  it('参考作品保留编辑入口和清空确认，取消不丢内容，清空后不留空菜单', async () => {
    project({ referenceWorks: '保留这段参考说明。' })
    await page.viewport(1040, 900)
    await mount()
    const references = () => useProjectStore.getState().currentProject!.novelConfig.referenceWorks
    await click(byName('编辑参考作品'))
    expect(useEditorStore.getState().tabs.some(tab => tab.configField === 'referenceWorks' && tab.projectKey === PATH)).toBe(true)
    await act(async () => host!.querySelector<HTMLElement>('.stage-setup-scroll')!.scrollTo(0, 10000))
    await click(byName('「参考作品」的更多操作'))
    await act(async () => page.getByRole('menuitem', { name: '清空此节…' }).click())
    await act(async () => page.getByRole('button', { name: '取消', exact: true }).click())
    expect(references()).toBe('保留这段参考说明。')
    await click(byName('「参考作品」的更多操作'))
    await act(async () => page.getByRole('menuitem', { name: '清空此节…' }).click())
    await act(async () => page.getByRole('button', { name: '清空此节', exact: true }).click())
    expect(references()).toBe('')
    expect(byName('「参考作品」的更多操作')).toBeUndefined()
    expect(host!.querySelector('.writing-options-references')!.textContent).toContain('未填写')
  })

  it('篇幅预估随输入更新，空值和不安全的字数不显示误导性总数', async () => {
    project({ genre: '悬疑', targetAudience: '全龄' })
    await mount()
    const estimate = () => host!.querySelector('.writing-options-estimate')!.textContent
    expect(estimate()).toContain('72,000 字')
    await write(field(/^总章数/) as HTMLInputElement, '30')
    expect(estimate()).toContain('90,000 字')
    await write(field(/^每章字数/) as HTMLInputElement, '')
    expect(estimate()).toContain('填写篇幅后显示全书预估字数')
    expect(next().disabled).toBe(true)
    await write(field(/^每章字数/) as HTMLInputElement, '9007199254740992')
    expect(estimate()).not.toContain('预计全书')
  })

  it('可见标签聚焦对应输入，说明与控件关联，AI 不可用原因直接展示', async () => {
    project({})
    await mount()
    const genre = field(/^类型/) as HTMLSelectElement
    await click(genre.labels![0])
    expect(document.activeElement).toBe(genre)
    expect(genre.getAttribute('aria-required')).toBe('true')
    expect(document.getElementById(genre.getAttribute('aria-describedby')!)?.textContent).toContain('选择作品的主要类型')
    const reason = document.getElementById(byName('AI 补全其余设定')!.getAttribute('aria-describedby')!)!
    expect(reason.textContent).toBe('先写大纲，AI 按它补全其余设定')
    expect(getComputedStyle(reason).position).not.toBe('absolute')
  })

  it.each([
    { width: 1040, theme: 'light', locale: 'zh-CN', filled: true },
    { width: 1040, theme: 'light', locale: 'zh-CN', filled: false },
    { width: 600, theme: 'dark', locale: 'zh-CN', filled: true },
    { width: 600, theme: 'dark', locale: 'zh-CN', filled: false },
    { width: 360, theme: 'light', locale: 'zh-CN', filled: false },
    { width: 360, theme: 'dark', locale: 'en-US', filled: true },
  ] as const)('$width / $theme / $locale / filled=$filled：区块对齐，输入与操作栏不溢出', async ({ width, theme, locale, filled }) => {
    useLocaleStore.setState({ locale })
    project({ genre: '悬疑', targetAudience: '全龄', referenceWorks: filled ? '参考《雾岛来信》的悬疑氛围与多线叙事。' : '' })
    await page.viewport(width, 900)
    await mount()
    host!.style.cssText = `width: ${width}px; height: 900px;`
    host!.dataset.theme = theme
    const scroll = host!.querySelector<HTMLElement>('.stage-setup-scroll')!
    await expect.poll(() => scroll.clientWidth).toBe(width)
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1)
    const bounds = host!.getBoundingClientRect()
    for (const control of host!.querySelectorAll('input, select, button')) {
      const box = control.getBoundingClientRect()
      expect(box.left).toBeGreaterThanOrEqual(bounds.left)
      expect(box.right).toBeLessThanOrEqual(bounds.right + 1)
    }
    const genre = field(locale === 'zh-CN' ? /^类型/ : /^Genre/).getBoundingClientRect()
    const audience = field(locale === 'zh-CN' ? /^目标读者/ : /^Target readers/).getBoundingClientRect()
    expect(width > 440 ? genre.top === audience.top : audience.top > genre.bottom).toBe(true)
    const cards = [...host!.querySelectorAll<HTMLElement>('.writing-options-card')]
    const headers = cards.map(card => card.querySelector<HTMLElement>('.writing-options-section-head')!)
    expect(cards).toHaveLength(3)
    for (const header of headers) {
      expect(header.getBoundingClientRect().left).toBe(headers[0].getBoundingClientRect().left)
      expect(getComputedStyle(header.querySelector('h2')!).font).toBe(getComputedStyle(headers[0].querySelector('h2')!).font)
      expect(header.querySelector('p')!.getBoundingClientRect().left).toBe(headers[0].querySelector('p')!.getBoundingClientRect().left)
    }
    const reference = cards[2]
    expect(reference.querySelectorAll('section, .arch-section, .writing-options-card')).toHaveLength(0)
    const actions = reference.querySelector<HTMLElement>('.writing-options-reference-actions')!
    const buttons = actions.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => buttons[0].focus())
    expect(getComputedStyle(reference).boxShadow).toBe('none')
    expect(getComputedStyle(actions).justifyContent).toBe('flex-end')
    expect(buttons[buttons.length - 1].getBoundingClientRect().right).toBeCloseTo(headers[2].getBoundingClientRect().right, 0)
    if (!filled) expect(buttons).toHaveLength(1)
    scroll.scrollTop = 0
    const screenshot = (part: string) => page.screenshot({ element: host!, path: `../../../../../.runtime/writing-options-${width}-${theme}-${locale}-${filled ? 'filled' : 'empty'}-${part}.png` })
    await screenshot('top')
    scroll.scrollTop = scroll.scrollHeight
    const assist = host!.querySelector('.writing-options-assist')!.getBoundingClientRect()
    const footer = host!.querySelector('.stage-setup-foot')!.getBoundingClientRect()
    expect(assist.bottom).toBeLessThanOrEqual(footer.top)
    expect(footer.bottom).toBeLessThanOrEqual(bounds.bottom + 1)
    await screenshot('bottom')
  })

  it('必填未齐时下一步不可用，提示写明还缺哪几项；补齐后才能往下走', async () => {
    project({})
    await mount()
    expect(next().disabled).toBe(true)
    expect(hint()).toBe('还差 2 项：类型、目标读者')
    expect(next().getAttribute('aria-describedby')).toBe(host!.querySelector('.stage-setup-foot [role="status"]')!.id)

    await choose(field(/^类型/) as HTMLSelectElement, '悬疑')
    expect(hint()).toBe('选好目标读者就能继续')
    expect(next().disabled).toBe(true)

    await choose(field(/^目标读者/) as HTMLSelectElement, '全龄')
    expect(hint()).toBe('基本信息已齐全')
    expect(next().disabled).toBe(false)
    expect([...host!.querySelectorAll('.pi-btn--primary')]).toHaveLength(1)
  })

  it('下一步先保存设定再去架构', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: PATH, dirty: true }] as never, activeTabId: 'config' })
    await mount()
    await click(next())
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toContain('chapter-card')
  })

  describe('下一步的保存还没返回时作者已经离开，保存完成后不把作者拉去架构', () => {
    let finishSave: (saved: boolean) => void = () => {}
    async function clickNextWithSlowSave() {
      project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
      dirtyConfigTab()
      useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
      await mount()
      await click(next())
    }

    it('回到了书房', async () => {
      await clickNextWithSlowSave()
      await act(async () => useLayoutStore.getState().setSidebarView('home'))
      await act(async () => finishSave(true))
      expect(useLayoutStore.getState().sidebarView).toBe('home')
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
    })

    it('打开了设置页', async () => {
      await clickNextWithSlowSave()
      await act(async () => useLayoutStore.setState({ settingsOpen: true, settingsSection: 'llm' }))
      await act(async () => finishSave(true))
      expect(useLayoutStore.getState().settingsOpen).toBe(true)
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
    })

    it('换到了这部作品的另一个标签', async () => {
      await clickNextWithSlowSave()
      await act(async () => useEditorStore.setState(state => ({
        tabs: [...state.tabs, { id: 'kb', name: '知识库', type: 'knowledge-base', projectKey: PATH, dirty: false } as never],
        activeTabId: 'kb',
      })))
      await act(async () => finishSave(true))
      expect(useEditorStore.getState().activeTabId).toBe('kb')
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config', 'knowledge-base'])
    })

    // 换作品时会话先失效，save 返回 false 就停了，走不到位置比较。
    it('打开了另一部作品', async () => {
      await clickNextWithSlowSave()
      const other = { projectId: 'harbor', leaseId: 'lease-2', projectPath: 'C:\\novels\\harbor' }
      setActiveProjectSessionContext(other)
      await act(async () => useProjectStore.setState({ currentProject: { id: 'harbor', sessionLease: 'lease-2', name: '港口', path: other.projectPath, novelConfig: { ...BLANK } } as unknown as ProjectData }))
      await act(async () => finishSave(true))
      expect(useEditorStore.getState().tabs.filter(tab => tab.projectKey === other.projectPath)).toEqual([])
    })
  })

  it('Ctrl S 的保存还没返回时下一步不可点，返回后可点并去架构', async () => {
    let finishSave: (saved: boolean) => void = () => {}
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
    await mount()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    expect(next().disabled).toBe(true)
    await act(async () => {
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, dirty: false })) }))
      finishSave(true)
    })
    expect(next().disabled).toBe(false)
    await click(next())
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toContain('chapter-card')
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
  })

  it('篇幅超出安全整数时仍算没填全，与预览卡（主进程按安全整数判断）一致', async () => {
    project({ totalChapters: 2 ** 53 })
    await mount()
    expect(next().disabled).toBe(true)
  })

  it('AI 按钮不可用时读屏能听到原因', async () => {
    useLLMStore.setState({ loaded: true, defaultModelId: null })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    const reason = (button: HTMLButtonElement | undefined) => document.getElementById(button!.getAttribute('aria-describedby') ?? '')?.textContent
    expect(reason(byName('AI 补全其余设定'))).toBe('先在设置里添加 AI 模型')
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
    project({})
    await mount()
    expect(reason(byName('AI 补全其余设定'))).toBe('先写大纲，AI 按它补全其余设定')
  })

  it('AI 按钮按规划环节实际能用的模型判断，和点下去时的门槛一致', async () => {
    const reason = (button: HTMLButtonElement | undefined) => document.getElementById(button!.getAttribute('aria-describedby') ?? '')?.textContent
    useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['refinement'] }] as never, defaultModelId: 'model', stageModelIds: {} })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(reason(byName('AI 补全其余设定'))).toBe('先在设置里添加 AI 模型')
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, models: [{ id: 'planner', purposes: ['generation'] }] as never, defaultModelId: null, stageModelIds: { planning: 'planner' } })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(byName('AI 补全其余设定')?.disabled).toBe(false)
  })

  it('保存失败时页面写明设定还在、可以再保存；点保存、Ctrl S 都一样', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(async () => false) } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    expect(alertText()).toBe('')

    await click(byName(/^保存/))
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(byName(/^保存/)?.disabled).toBe(false)

    await write(field(/^细分类型/) as HTMLInputElement, '海港悬疑')
    expect(alertText()).toBe('')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(2)
  })

  it('下一步保存失败时留在设定页并写明原因', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(async () => { throw new Error('磁盘已满') }) } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    await click(next())
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
  })

  it('AI 补全以大纲为脑洞启动；已有作者内容时先确认扩写', async () => {
    project({ coreOutline: '雾钟提前一刻响起。',  })
    await mount()
    await click(byName('AI 补全其余设定'))
    const startWorkflow = useWorkflowStore.getState().startWorkflow
    expect(startWorkflow).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('扩写已有的设定？')
    expect([...dialog.querySelectorAll('li')].map(item => item.textContent)).toEqual(['大纲'])

    await click(byName('继续扩写'))
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ type: 'config_generation', projectPath: PATH, projectSession: SESSION }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('另一个任务占着设定时 AI 补全不启动，扩写确认留着', async () => {
    project({ coreOutline: '雾钟提前一刻响起。',  })
    useWorkflowStore.setState({ getResourceConflict: () => ({ title: '生成架构' }) } as never)
    await mount()
    await click(byName('AI 补全其余设定'))
    await click(byName('继续扩写'))
    expect(useWorkflowStore.getState().startWorkflow).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('扩写已有的设定？')
  })

  it('没有大纲时 AI 补全不可用；没有模型时所有 AI 按钮不可用并给出添加模型的入口', async () => {
    project({})
    await mount()
    expect(byName('AI 补全其余设定')?.disabled).toBe(true)
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, defaultModelId: null })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(byName('AI 补全其余设定')?.disabled).toBe(true)
    expect(host!.textContent).toContain('还没有连接 AI 模型')
    await click(byName('添加模型'))
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  })

  it('伏笔沉寂提醒清空后重新输入：退格删掉 5 再输 7 得 7，不是 17；空着离开回到默认的 3 章', async () => {
    project({ narrativeThreadDormantChapterThreshold: 5 })
    await mount()
const input = host!.querySelector<HTMLInputElement>('input[aria-label="伏笔沉寂提醒（章）"]')!
    // 上一条用例留下的提示会挡住指针，直接聚焦后用键盘输入。
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('7')
    expect(input.value).toBe('7')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('3')
  })
})

describe('设定页的保存跨切标签', () => {
  it('Ctrl S 的保存还没返回时切到别的标签再切回：下一步仍不可点，再按 Ctrl S 也不重发，保存只发 1 次', async () => {
    let finishSave: (saved: boolean) => void = () => {}
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
    await mount()
    const ctrlS = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    await ctrlS()
    await act(async () => root!.render(<Shortcuts />))
    await act(async () => root!.render(<><Shortcuts /><StageSetup projectKey={PATH} /></>))
    expect(next().disabled).toBe(true)
    await click(next())
    await ctrlS()
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
    await act(async () => {
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, dirty: false })) }))
      finishSave(true)
    })
    expect(next().disabled).toBe(false)
  })
})
