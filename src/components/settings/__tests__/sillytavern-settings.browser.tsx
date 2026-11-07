import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import SillyTavernSettings from '../SillyTavernSettings'
import StageSettings from '../../stage/settings/StageSettings'
import { useLayoutStore } from '../../../stores/layout-store'
import '../../../index.css'
import { useLocaleStore } from '../../../stores/locale-store'
import { EMPTY_TAVERN_SETTINGS, importTavernPreset, type TavernSettings } from '../../../shared/sillytavern-preset'
import samplePreset from '../../../../docs/1.99__.json?raw'
import wavePreset from '../../../../docs/我即浪潮-1105-Éclat·Turing.json?raw'

let root: Root | undefined
let container: HTMLDivElement | undefined
const originalLocale = useLocaleStore.getState()
const originalLayout = useLayoutStore.getState()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove(); root = undefined; container = undefined
  useLocaleStore.setState(originalLocale)
  useLayoutStore.setState(originalLayout)
})
async function mount(shell = false) {
  container = document.createElement('div'); document.body.append(container)
  container.className = 'paper-ink stage-shell'
  container.style.cssText = shell ? 'width:100vw;height:100vh;display:flex' : 'max-width:1100px;margin:auto;padding:24px'
  root = createRoot(container)
  await act(async () => root!.render(shell ? <StageSettings library /> : <SillyTavernSettings />))
}
const preset = JSON.stringify({ prompts: [
  { identifier: 'vars', name: '变量定义', role: 'system', content: '{{setvar::字数::800}}' },
  { identifier: 'main', name: '正文指令', role: 'system', content: '写 {{getvar::字数}} 字，作者 {{user}}' },
  { identifier: 'chatHistory', name: '聊天历史', marker: true },
], prompt_order: [{ character_id: 100001, order: [
  { identifier: 'vars', enabled: true }, { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
] }] })

it('previews the random-heavy Éclat preset, keeps results across tabs and rerolls without changing settings', async () => {
  const entry = importTavernPreset(wavePreset, 'Éclat·Turing.json', 'wave')
  const invoke = vi.fn(async () => ({ sillyTavern: { presets: [entry], activePresetId: 'wave', scope: 'text' } }))
  Object.assign(window, { aiNovelAPI: { invoke } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  await mount()
  await act(async () => page.getByRole('tab', { name: '发送预览', exact: true }).click())
  expect(container!.querySelector('[role="alert"]')).toBeNull()
  const content = () => [...container!.querySelectorAll('.tavern-message pre')].map(node => node.textContent).join('\n')
  const first = content()
  expect(first).not.toContain('{{random')
  expect(new Set(first.match(/[א-ת]/gu)).size).toBeGreaterThan(15)
  await act(async () => page.getByRole('tab', { name: /变量与宏/ }).click())
  expect(page.getByRole('button', { name: '编辑变量 random', exact: true }).query()).toBeNull()
  await act(async () => page.getByRole('tab', { name: '发送预览', exact: true }).click())
  expect(content()).toBe(first)
  await act(async () => page.getByRole('button', { name: '重新随机', exact: true }).click())
  expect(content()).not.toBe(first)
  await expect.element(page.getByRole('button', { name: '保存预设设置' })).toBeDisabled()
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('imports, edits variables and switches, previews, saves and reloads the selected preset', async () => {
  let saved: TavernSettings = structuredClone(EMPTY_TAVERN_SETTINGS)
  const invoke = vi.fn(async (channel: string, value?: { sillyTavern: TavernSettings }) => {
    if (channel === 'config:get') return { sillyTavern: structuredClone(saved) }
    if (channel === 'config:set') { saved = structuredClone(value!.sillyTavern); return { success: true } }
    throw new Error(channel)
  })
  Object.assign(window, { aiNovelAPI: { invoke } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  await mount()
  await act(async () => userEvent.upload(page.getByLabelText('导入预设文件'), new File([preset], 'demo.json', { type: 'application/json' })))
  await expect.element(page.getByLabelText('查看 / 编辑预设')).toHaveValue(expect.any(String))
  await act(async () => page.getByRole('button', { name: '使用此预设' }).click())
  await act(async () => page.getByRole('tab', { name: /变量与宏/ }).click())
  await expect.element(page.getByLabelText('字数', { exact: true })).toHaveValue('800')
  await act(async () => page.getByLabelText('覆盖 字数', { exact: true }).click())
  await act(async () => page.getByLabelText('字数', { exact: true }).fill('1600'))
  await act(async () => page.getByRole('button', { name: '编辑变量 user', exact: true }).click())
  await act(async () => page.getByLabelText('{{user}}', { exact: true }).fill('小林'))
  await act(async () => page.getByRole('tab', { name: '发送预览', exact: true }).click())
  await expect.element(page.getByText('写 1600 字，作者 小林', { exact: true }).first()).toBeVisible()
  await act(async () => page.getByRole('tab', { name: /提示词条目/ }).click())
  await act(async () => page.getByLabelText('启用 正文指令', { exact: true }).click())
  await act(async () => page.getByRole('tab', { name: '发送预览', exact: true }).click())
  expect(page.getByText('写 1600 字，作者 小林', { exact: true }).query()).toBeNull()
  await act(async () => page.getByRole('tab', { name: /提示词条目/ }).click())
  await act(async () => page.getByLabelText('启用 正文指令', { exact: true }).click())
  await act(async () => page.getByRole('button', { name: '保存预设设置' }).click())
  expect(saved.presets[0].variables).toEqual({ 字数: '1600' })
  expect(saved.activePresetId).toBe(saved.presets[0].id)
  await act(async () => root!.unmount()); container!.remove()
  await mount()
  await expect.element(page.getByRole('button', { name: '停用此预设' })).toHaveAttribute('aria-pressed', 'true')
  await act(async () => page.getByRole('tab', { name: /变量与宏/ }).click())
  await expect.element(page.getByLabelText('字数', { exact: true })).toHaveValue('1600')
  await act(async () => page.getByRole('button', { name: '编辑变量 user', exact: true }).click())
  await expect.element(page.getByLabelText('{{user}}', { exact: true })).toHaveValue('小林')
})

it('keeps the previous library on invalid import and surfaces persistence failures', async () => {
  const invoke = vi.fn(async (channel: string) => channel === 'config:get' ? {} : { success: false, error: 'disk full' })
  Object.assign(window, { aiNovelAPI: { invoke } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  await mount()
  await act(async () => userEvent.upload(page.getByLabelText('导入预设文件'), new File(['{}'], 'bad.json')))
  await expect.element(page.getByRole('alert')).toHaveTextContent('无效')
  expect(page.getByLabelText('查看 / 编辑预设').query()).toBeNull()
  await act(async () => userEvent.upload(page.getByLabelText('导入预设文件'), new File([preset], 'good.json')))
  await act(async () => page.getByRole('button', { name: '保存预设设置' }).click())
  await expect.element(page.getByRole('alert')).toHaveTextContent('disk full')
  await expect.element(page.getByRole('button', { name: '保存预设设置' })).toBeEnabled()
})

it('opens the supplied large preset and exposes its custom macros and ordered entries', async () => {
  Object.assign(window, { aiNovelAPI: { invoke: vi.fn(async () => ({})) } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  await page.viewport(1000, 850)
  await mount()
  await act(async () => userEvent.upload(page.getByLabelText('导入预设文件'), new File([samplePreset], '1.99__.json')))
  await expect.element(page.getByLabelText('搜索条目')).toBeVisible()
  await act(async () => page.getByLabelText('搜索条目').fill('字数·短篇'))
  await expect.element(page.getByRole('checkbox', { name: '启用 📏字数·短篇', exact: true })).toBeChecked()
  await act(async () => page.getByRole('tab', { name: /变量与宏/ }).click())
  await expect.element(page.getByLabelText('{{count_total}}', { exact: true })).toBeVisible()
  await act(async () => page.getByLabelText('{{count_total}}', { exact: true }).fill('1'))
  await expect.element(page.getByLabelText('{{count_total}}', { exact: true })).toHaveValue('1')
  await act(async () => userEvent.keyboard('2'))
  await expect.element(page.getByLabelText('{{count_total}}', { exact: true })).toHaveValue('12')
  await act(async () => page.getByRole('tab', { name: /提示词条目/ }).click())
  await expect.element(page.getByLabelText('搜索条目')).toHaveValue('字数·短篇')
  await page.screenshot({ fullPage: true })
})

it('supports editing in place, filtering, keyboard tabs and undoing a removal', async () => {
  const entry = importTavernPreset(preset, 'saved.json', 'saved')
  Object.assign(window, { aiNovelAPI: { invoke: vi.fn(async () => ({ sillyTavern: { presets: [entry], activePresetId: 'saved', scope: 'text' } })) } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  await mount()
  await act(async () => page.getByRole('button', { name: /正文指令/ }).click())
  await act(async () => page.getByLabelText('条目内容', { exact: true }).fill('新的创作指导'))
  await act(async () => page.getByRole('button', { name: '上移当前条目' }).click())
  expect(container!.querySelector('.tavern-prompt-row button')!.textContent).toContain('正文指令')
  await act(async () => page.getByLabelText('条目筛选').selectOptions('disabled'))
  await expect.element(page.getByText('没有匹配的条目')).toBeVisible()
  await act(async () => page.getByRole('button', { name: '清除筛选' }).click())
  await act(async () => {
    page.getByRole('tab', { name: /提示词条目/ }).element().focus()
    await userEvent.keyboard('{ArrowRight}')
  })
  await expect.element(page.getByRole('tab', { name: /变量与宏/ })).toHaveAttribute('aria-selected', 'true')
  await act(async () => page.getByRole('tab', { name: '预设设置', exact: true }).click())
  await act(async () => page.getByRole('button', { name: '移除此预设' }).click())
  await expect.element(page.getByRole('button', { name: '撤销移除' })).toBeVisible()
  await act(async () => page.getByRole('button', { name: '撤销移除' }).click())
  await act(async () => page.getByRole('tab', { name: /提示词条目/ }).click())
  await expect.element(page.getByLabelText('条目内容', { exact: true })).toHaveValue('新的创作指导')
  await act(async () => page.getByRole('button', { name: '放弃修改', exact: true }).click())
  await act(async () => page.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click())
  await act(async () => page.getByRole('button', { name: /正文指令/ }).click())
  await expect.element(page.getByLabelText('条目内容', { exact: true })).toHaveValue('写 {{getvar::字数}} 字，作者 {{user}}')
})

it('renders the independent page with the supplied preset in light, dark and narrow layouts', async () => {
  const entry = importTavernPreset(samplePreset, '1.99__.json', 'sample')
  Object.assign(window, { aiNovelAPI: { invoke: vi.fn(async () => ({ sillyTavern: { presets: [entry], activePresetId: 'sample', scope: 'text' } })) } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ settingsSection: 'prompt-presets' })
  await page.viewport(1440, 1000)
  await mount(true)
  await expect.element(page.getByRole('heading', { name: '提示词预设', exact: true })).toBeVisible()
  await act(async () => page.getByRole('button', { name: /叙事核心协议/ }).click())
  await page.screenshot({ fullPage: true })
  container!.dataset.theme = 'dark'
  await page.screenshot({ fullPage: true })
  await act(async () => page.getByRole('tab', { name: /变量与宏/ }).click())
  await expect.element(page.getByLabelText('{{count_total}}', { exact: true })).toBeVisible()
  await page.screenshot({ fullPage: true })
  await page.viewport(900, 850)
  const workspace = container!.querySelector('.tavern-workspace')!
  expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1)
  expect(container!.scrollWidth).toBeLessThanOrEqual(900)
  await page.screenshot({ fullPage: true })
})
