import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { useThemeStore } from '../../../stores/theme-store'
import type { AIRequestRecord } from '../../../shared/ai-request-log'
import AIRequestLogDialog from '../AIRequestLogDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const win = window as unknown as { aiNovelAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
let root: Root
let host: HTMLDivElement
let records: AIRequestRecord[]
let fail = false
const initialTheme = useThemeStore.getState().resolvedTheme
const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
  if (fail) throw new Error('unavailable')
  if (channel === 'llm:request-log-list') return structuredClone(records)
  if (channel === 'llm:request-log-detail') return structuredClone(records.find(record => record.id === args[0]) ?? null)
})
const dialog = () => document.querySelector('[role="dialog"]')!
const click = async (element: Element) => {
  await act(async () => { (element as HTMLElement).click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
}
const open = async () => { await click(host.querySelector('button')!) }
const waitForText = async (value: string) => {
  await expect.poll(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    return dialog()?.textContent
  }).toContain(value)
}

beforeEach(async () => {
  fail = false
  invoke.mockClear()
  records = [{
    id: '1', startedAt: Date.now(), durationMs: 1000, modelId: 'test-model', modelName: '测试模型',
    protocol: 'openai', streaming: true, status: 'running', revision: 1,
    messages: [{ role: 'system', content: '保持人物一致。' }, { role: 'user', content: '写一段开场。' }],
    response: '雨落', parameters: { temperature: 0.7, maxTokens: 1000 },
  }]
  win.aiNovelAPI = { invoke }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<AIRequestLogDialog />) })
})

afterEach(async () => {
  await act(async () => root.unmount())
  useThemeStore.setState({ resolvedTheme: initialTheme })
  host.remove()
  delete win.aiNovelAPI
})

it('opens details, updates a streaming answer and usage, then stops polling on close', async () => {
  expect(invoke).not.toHaveBeenCalled()
  await open()
  await waitForText('测试模型')
  await click(dialog().querySelector('.ai-log-row')!)
  await waitForText('保持人物一致。')
  expect(dialog().textContent).toContain('System prompt')
  expect(dialog().textContent).toContain('User prompt')
  expect(dialog().textContent).toContain('写一段开场。')
  expect(dialog().textContent).toContain('未提供')
  expect(dialog().textContent).toContain('雨落')
  records = [{ ...records[0], response: '雨落在窗前。', revision: 2, status: 'succeeded', finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 } }]
  await waitForText('雨落在窗前。')
  expect(dialog().textContent).toContain('12 / 8 / 20')
  expect(dialog().textContent).toContain('已完成')
  await click(dialog().querySelector('button[aria-label="关闭"]')!)
  const calls = invoke.mock.calls.length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(invoke).toHaveBeenCalledTimes(calls)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows an empty state and recovers from a read failure', async () => {
  records = []
  fail = true
  await open()
  await waitForText('读取记录失败')
  fail = false
  await waitForText('暂无 AI 请求记录')
  expect(dialog().querySelector('[role="alert"]')).toBeNull()
})

it('discards a selected record when it ages out of the latest 50', async () => {
  await open()
  await waitForText('测试模型')
  await click(dialog().querySelector('.ai-log-row')!)
  await waitForText('保持人物一致。')
  records = []
  await waitForText('选择一条记录')
  expect(dialog().textContent).not.toContain('保持人物一致。')
})

it.each([{ width: 1200, theme: 'light' as const }, { width: 600, theme: 'dark' as const }])(
  'keeps long prompts readable at $width px in $theme mode', async ({ width, theme }) => {
    await page.viewport(width, 800)
    useThemeStore.setState({ resolvedTheme: theme })
    records[0].messages[1].content = '写一段开场。\n' + '无空格的长提示词'.repeat(80)
    await open()
    await waitForText('测试模型')
    await click(dialog().querySelector('.ai-log-row')!)
    await waitForText('System prompt')
    const box = dialog().getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(width)
    const details = dialog().querySelector('.ai-log-detail')!
    expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth + 1)
    expect(details.clientHeight).toBeGreaterThan(150)
    await page.screenshot({ path: `../../../../.runtime/ai-request-log-${theme}.png` })
  },
)
