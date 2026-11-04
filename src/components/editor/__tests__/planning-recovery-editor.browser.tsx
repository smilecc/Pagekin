import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlueprintRecoveryDiagnostic, GenerationRecoveryContext } from '../../../shared/generation-owner-contract'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { openPlanningRecoveryDraft, registerEditorExitSaveHandler, saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import StageBlueprint from '../../stage/blueprint/StageBlueprint'
import RunSheet from '../../stage/run/RunSheet'
import BlueprintRecovery from '../../stage/blueprint/BlueprintRecovery'
import StageWorkspace from '../../stage/StageWorkspace'

const session = { projectId: 'recovery-project', leaseId: 'lease-1', projectPath: 'C:\\synthetic\\planning-recovery' }
const handle = { projectId: session.projectId, epoch: 'epoch-original', rootActionId: 'root-1', runId: 'run-1' }
const project: ProjectData = {
  id: session.projectId, sessionLease: session.leaseId, name: 'Recovery', path: session.projectPath,
  novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 3, wordsPerChapter: 2000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '调查失踪信件，揭开城中秘密。',    globalGuidance: '' },
  characterStates: '', createdAt: '', updatedAt: '',
}
function fixture(): GenerationRecoveryContext {
  const common: GenerationRecoveryContext = {
    modelId: 'model', handle, operation: 'generate-directory', authorInputs: [],
    selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [], composition: null,
    lastCompositionFinishReason: 'length', attemptedPurposes: ['normal', 'compact'], draftSave: { kind: 'absent' },
    planningContinuation: { sourceHandle: handle, remainingRange: { from: 1, to: 3 }, targetUnits: 600, state: 'ready' },
  }
  return { ...common, blueprintRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId,
    draft: '[{"chapterNumber":1,"title":"未完成', editRange: { from: 1, to: 3 }, writeState: 'ready', saved: null } }
}
const blueprintText = JSON.stringify([{ chapterNumber: 1, title: '雨夜', keyEvents: '找到信件', characters: ['沈砺'] }])
let root: Root
let container: HTMLDivElement
let context: GenerationRecoveryContext
let invoke: ReturnType<typeof vi.fn>
let rejectSave: string | undefined
let pendingSave: (() => Promise<unknown>) | undefined
let savedPayload: unknown
let showCandidate: boolean
const initialEditor = useEditorStore.getState()
const initialProject = useProjectStore.getState()
const initialWorkflow = useWorkflowStore.getState()
const initialLLM = useLLMStore.getState()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  context = fixture(); rejectSave = undefined; pendingSave = undefined; savedPayload = undefined; showCandidate = false
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
  useLLMStore.setState({ models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:read-context') return context
    if (channel === 'db:blueprint-commit-range') {
      savedPayload = args[0]
      if (pendingSave) return pendingSave()
      return rejectSave ? { success: false, error: rejectSave } : { success: true }
    }
    if (channel === 'db:project-core-get') return { title: 'Recovery', worldbuilding: '世界设定'.repeat(20) }
    if (channel === 'generation:list') return showCandidate ? [{ handle, status: 'failed', artifacts: [], candidates: [] }] : []
    if (channel === 'generation:list-recovery') return { planning: showCandidate ? [context] : [], editors: [], reviews: [], batches: [], drafts: [], partial: false }
    if (channel === 'generation:find-blueprint-recovery') return showCandidate && context.blueprintRecovery ? context : null
    if (channel === 'db:recovery-candidate-list') return []
    if (channel === 'skills:list-user' || channel === 'db:blueprint-get-all') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'fs:read-json') return { success: true, data: {} }
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'db:character-roster-read') return { status: 'ready', renderedMarkdown: '沈砺', entries: [] }
    if (channel === 'db:character-get-all') return [{ id: 'character-1', name: '沈砺' }]
    if (channel === 'db:draft-authority-sequence') return { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64) }
    if (channel === 'generation:restart') throw new Error('RESTART_BOUNDARY_OBSERVED')
    throw new Error(`Unexpected IPC ${channel}`)
  })
  Object.assign(window, { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useEditorStore.getState().clearTabs()
  useEditorStore.setState(initialEditor); useProjectStore.setState(initialProject); useWorkflowStore.setState(initialWorkflow)
  useLLMStore.setState(initialLLM)
  setActiveProjectSessionContext(null); Reflect.deleteProperty(window, 'aiNovelAPI'); vi.restoreAllMocks()
})
async function render() {
  openPlanningRecoveryDraft(context, session.projectPath, '恢复稿')
  const tab = useEditorStore.getState().tabs[0]
  await act(async () => root.render(<BlueprintRecovery tab={tab} projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull())
}
function editor(): EditorView {
  const element = container.querySelector<HTMLElement>('.cm-editor')
  const view = element && EditorView.findFromDOM(element)
  if (!view) throw new Error('Missing editor')
  return view
}
async function edit(value: string) { await act(async () => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }) }) }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
function noModel() { expect(invoke.mock.calls.some(([channel]) => channel === 'generation:execute' || channel === 'generation:begin' || channel === 'generation:restart')).toBe(false) }

describe('planning recovery editors', () => {
  it('新外壳里故事规划恢复稿标签打开纸墨恢复页：保存终点、保存与继续两个按钮、原始候选，保存只按作者选的终点写入', async () => {
    context = fixture()
    openPlanningRecoveryDraft(context, session.projectPath, '故事规划恢复稿')
    await act(async () => root.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull())
    const page = container.querySelector('[aria-label="故事规划恢复"]')!
    expect(page.querySelector('h1')?.textContent).toBe('补齐中断的故事规划')
    expect(page.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
    expect(page.querySelector('details pre')?.textContent).toBe(context.blueprintRecovery!.draft)
    expect(button('继续生成缺少的章节').disabled).toBe(false)
    await edit(blueprintText)
    await act(async () => button('保存恢复故事规划').click())
    expect(savedPayload).toMatchObject({ mode: 'replace-range', startChapter: 1, endChapter: 1 })
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: blueprintText, dirty: false })
    noModel()
  })
  it('故事规划恢复页打开时读不出恢复上下文：提示只写原因，不带 Error 前缀', async () => {
    context = fixture()
    openPlanningRecoveryDraft(context, session.projectPath, '故事规划恢复稿')
    const plain = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'generation:read-context') throw new Error('恢复上下文读取失败')
      return plain(channel, ...args)
    })
    const tab = useEditorStore.getState().tabs[0]
    await act(async () => root.render(<BlueprintRecovery tab={tab} projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('恢复上下文读取失败'))
    noModel()
  })
  it('英文界面下保存恢复故事规划被拒、又没带原因时，提示也是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    context = fixture()
    await render()
    await edit(blueprintText)
    pendingSave = async () => ({ success: false })
    await act(async () => button('Save recovered blueprints').click())
    const alert = await vi.waitFor(() => {
      const found = container.querySelector('[role="alert"]')?.textContent
      expect(found).toBeTruthy()
      return found!
    })
    expect(alert).toBe('Could not save the recovered blueprints.')
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
    noModel()
  })
  it('英文界面下恢复稿不合故事规划格式时，按英文说明哪个字段出了什么问题，不带中文诊断前缀（#474）', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    context = fixture()
    await render()
    await edit(JSON.stringify([{ ...JSON.parse(blueprintText)[0], keyEvents: undefined }]))
    await act(async () => button('Save recovered blueprints').click())
    const alert = await vi.waitFor(() => {
      const found = container.querySelector('[role="alert"]')?.textContent
      expect(found).toBeTruthy()
      return found!
    })
    expect(alert).toMatch(/keyEvents/u)
    expect(alert).toMatch(/missing/iu)
    expect(alert).not.toMatch(/\p{Script=Han}/u)
    expect(savedPayload).toBeUndefined()
  })
  it('英文界面下主进程以中文诊断拒绝保存时，提示只给英文说明（#474）', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    context = fixture()
    await render()
    await edit(blueprintText)
    rejectSave = 'StructuredContractDiagnostic: 结构化合同诊断 code=missing_field path=blueprints[0].keyEvents field=keyEvents'
    await act(async () => button('Save recovered blueprints').click())
    const alert = await vi.waitFor(() => {
      const found = container.querySelector('[role="alert"]')?.textContent
      expect(found).toBeTruthy()
      return found!
    })
    expect(alert).toMatch(/^Could not save the recovered blueprints/u)
    expect(alert).not.toMatch(/\p{Script=Han}/u)
  })
  it('英文界面下读恢复上下文被主进程以错误码拒绝时，不露 Electron 通道前缀与原码（#474）', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    context = fixture()
    openPlanningRecoveryDraft(context, session.projectPath, 'Blueprint recovery')
    const plain = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'generation:read-context') throw new Error("Error invoking remote method 'generation:read-context': Error: GENERATION_PROJECT_SESSION_STALE")
      return plain(channel, ...args)
    })
    const tab = useEditorStore.getState().tabs[0]
    await act(async () => root.render(<BlueprintRecovery tab={tab} projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/switched or reopened/iu))
    expect(container.querySelector('[role="alert"]')?.textContent).not.toMatch(/Error invoking|GENERATION_/u)
  })

  it('reports a blueprint resource conflict without adding a failed continuation', async () => {
    context = fixture()
    await render()
    await act(async () => useWorkflowStore.setState({ activeRuns: [{
      id: 'running-blueprint', type: 'directory', title: '正在生成故事规划', status: 'running',
      projectPath: session.projectPath, projectSession: session, resourceKeys: ['blueprints'],
      writingLanguage: 'zh-CN', uiLocale: 'zh-CN', currentStepIndex: 0, steps: [], createdAt: '',
    }] }))
    await act(async () => button('继续生成缺少的章节').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('正在生成故事规划')
    expect(useWorkflowStore.getState().history).toHaveLength(0)
    noModel()
  })
  it.each([
    { kind: 'retired', code: 'GENERATION_BLUEPRINTS_CLEARED', reason: '故事规划已清空，旧恢复稿不能保存或续接' },
    { kind: 'invalid', code: 'GENERATION_DIRECTORY_PROGRESS_INVALID', reason: '故事规划生成进度校验失败，旧恢复稿不能保存或续接' },
    { kind: 'invalid', code: 'GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID', reason: '故事规划作者保存记录校验失败，旧恢复稿不能保存或续接' },
  ] satisfies (Omit<BlueprintRecoveryDiagnostic, 'runId'> & { reason: string })[])('unavailable blueprint $code keeps editable text without replaying a pending save', async diagnostic => {
    context = fixture()
    await render()
    const original = useEditorStore.getState().tabs[0].originalContent
    await edit(blueprintText)
    pendingSave = async () => { throw new Error('IPC_ACK_LOST_AFTER_COMMIT') }
    await act(async () => button('保存恢复故事规划').click())
    expect(useEditorStore.getState().tabs[0].planningSaveSnapshot?.status).toBe('pending')
    expect(invoke.mock.calls.filter(([name]) => name === 'db:blueprint-commit-range')).toHaveLength(1)
    if (!context.blueprintRecovery) throw new Error('Missing blueprint recovery')
    context = { ...context, planningContinuation: undefined, blueprintRecovery: {
      ...context.blueprintRecovery, writeState: 'unavailable', editRange: null, saved: null,
      diagnostic: { runId: handle.runId, kind: diagnostic.kind, code: diagnostic.code },
    } }
    await act(async () => root.render(null))
    await render()
    expect(container.textContent).toContain(diagnostic.reason)
    expect(container.querySelector('details pre')?.textContent).toBe(original)
    expect(editor().state.doc.toString()).toBe(blueprintText)
    expect(button('保存恢复故事规划').disabled).toBe(true)
    expect(button('继续生成缺少的章节').disabled).toBe(true)
    const later = blueprintText + '\n作者保留的修改'
    await edit(later)
    const data = new DataTransfer()
    await act(async () => {
      const view = editor(); view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(data.getData('text/plain')).toBe(later)
    await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
    expect(invoke.mock.calls.filter(([name]) => name === 'db:blueprint-commit-range')).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: later, originalContent: original, dirty: true })
    noModel()
  })
  for (const kind of ['blueprint'] as const) {
    const channel = 'db:blueprint-commit-range'
    const validText = () => blueprintText
    const recordAuthorReceipt = () => {
      context = structuredClone(context)
      const operationId = useEditorStore.getState().tabs[0].planningSaveOperationId
      if (!operationId) throw new Error('Missing operation ID')
      const receipt = { operationId, sourceHandle: handle, requestedRange: { from: 1, to: 3 }, committedRange: { from: 1, to: 1 }, remainingRange: { from: 2, to: 3 } }
      if (context.blueprintRecovery) {
        context.blueprintRecovery.saved = { ...receipt, kind: 'blueprint-author-edit', payloadHash: 'a'.repeat(64) }
        context.blueprintRecovery.writeState = 'author-saved'
        context.blueprintRecovery.editRange = { from: 2, to: 3 }
      }
      context.planningContinuation = { sourceHandle: handle, remainingRange: { from: 2, to: 3 }, targetUnits: 600, state: 'ready' }
    }
    const shortcutSave = async () => {
      await act(async () => editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
    }
    for (const retry of ['button', 'shortcut', 'exit', 'new-lease'] as const) {
      it(`${kind} lost save ACK retries frozen content after remount via ${retry}`, async () => {
        context = fixture(); await render(); await edit(validText())
        const original = useEditorStore.getState().tabs[0].originalContent
        let first: unknown
        pendingSave = async () => {
          first = structuredClone(savedPayload)
          recordAuthorReceipt()
          throw new Error('IPC_ACK_LOST_AFTER_COMMIT')
        }
        await act(async () => button('保存恢复故事规划').click())
        const later = validText().replace('找到信件', '找到新的信件')
        await edit(later)
        await act(async () => {
          const input = container.querySelector('input[type="number"]')
          if (!(input instanceof HTMLInputElement)) throw new Error('Missing range input')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '2')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => root.render(null))
        if (retry === 'new-lease') {
          setActiveProjectSessionContext({ ...session, leaseId: 'lease-2' })
          useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-2' } })
          if (context.blueprintRecovery) context.blueprintRecovery.leaseEpoch = 'lease-2'
        }
        await render()
        pendingSave = async () => ({ success: true })
        if (retry === 'exit') {
          await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow('保存期间仍有未保存修改') })
        } else if (retry === 'shortcut') await shortcutSave()
        else await act(async () => button('保存恢复故事规划').click())
        await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2))
        const expected = structuredClone(first)
        if (retry === 'new-lease') {
          if (!expected || typeof expected !== 'object' || !('authorRecovery' in expected)
            || !expected.authorRecovery || typeof expected.authorRecovery !== 'object') throw new Error('Missing author recovery request')
          Object.assign(expected.authorRecovery, { leaseEpoch: 'lease-2' })
        }
        expect(savedPayload, JSON.stringify({ first, second: savedPayload })).toEqual(expected)
        expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: later, savedContent: validText(), originalContent: original, dirty: true })
        await shortcutSave()
        expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
        expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: true })
        const data = new DataTransfer()
        await act(async () => {
          const view = editor(); view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
          view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
        })
        expect(data.getData('text/plain')).toBe(later)
        expect(button('保存恢复故事规划').disabled).toBe(true)
        noModel()
      })
    }
    it(`${kind} invalid first text can be corrected before any submission freezes`, async () => {
      context = fixture(); await render(); await edit('未完成内容')
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(0)
      await edit(validText())
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: false }); noModel()
    })
    it(`${kind} a late ACK from an old lease leaves its snapshot retryable`, async () => {
      context = fixture(); await render(); await edit(validText())
      let finish: ((value: unknown) => void) | undefined
      pendingSave = () => new Promise(resolve => { finish = resolve })
      await act(async () => button('保存恢复故事规划').click())
      await vi.waitFor(() => expect(finish).toBeDefined())
      const first = structuredClone(savedPayload)
      const later = validText().replace('找到信件', '找到新的信件')
      await edit(later)
      recordAuthorReceipt()
      setActiveProjectSessionContext({ ...session, leaseId: 'lease-2' })
      if (context.blueprintRecovery) context.blueprintRecovery.leaseEpoch = 'lease-2'
      await act(async () => {
        useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-2' } })
        finish?.({ success: true })
      })
      await act(async () => root.render(null))
      await render()
      pendingSave = async () => ({ success: true })
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
      expect(savedPayload).toMatchObject({ authorRecovery: { leaseEpoch: 'lease-2' } })
      if (!first || typeof first !== 'object' || !('authorRecovery' in first)
        || !first.authorRecovery || typeof first.authorRecovery !== 'object') throw new Error('Missing author recovery request')
      Object.assign(first.authorRecovery, { leaseEpoch: 'lease-2' })
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), content: later, dirty: true }); noModel()
    })
    it(`${kind} explicit uncommitted rejection permits corrected text on retry`, async () => {
      context = fixture(); rejectSave = '作者内容未通过检查'; await render(); await edit(validText())
      await act(async () => button('保存恢复故事规划').click())
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      const later = validText().replace('找到信件', '找到新的信件')
      await edit(later); rejectSave = undefined
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2)
      expect(savedPayload).toMatchObject({ blueprints: [{ keyEvents: '找到新的信件' }] })
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: later, dirty: false }); noModel()
    })
    it(`${kind} a rejected replay cannot release an earlier unknown submission`, async () => {
      context = fixture(); await render(); await edit(validText())
      pendingSave = async () => { throw new Error('IPC_ACK_UNKNOWN') }
      await act(async () => button('保存恢复故事规划').click())
      const first = structuredClone(savedPayload)
      await edit(validText().replace('找到信件', '找到新的信件'))
      pendingSave = async () => ({ success: false, error: 'AUTHOR_RECEIPT_CONFLICT' })
      await act(async () => button('保存恢复故事规划').click())
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0].savedContent).toBe('')
      pendingSave = async () => ({ success: true })
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(3)
      expect(savedPayload).toEqual(first)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ savedContent: validText(), dirty: true }); noModel()
    })
    it(`${kind} edits double-length candidate and saves only through author recovery`, async () => {
      context = fixture(); await render(); await edit(validText())
      const operationId = useEditorStore.getState().tabs[0].planningSaveOperationId
      await act(async () => button('保存恢复故事规划').click())
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
      expect(savedPayload).toMatchObject({ authorRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId } })
      expect(savedPayload).toMatchObject({ operationId, mode: 'replace-range', startChapter: 1, endChapter: 1, blueprints: [{ chapterNumber: 1, keyEvents: '找到信件' }] })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
      expect(invoke.mock.calls.some(([name]) => /upsert|project-core-update/.test(name))).toBe(false); noModel()
    })
    it(`${kind} preserves dirty and operation identity after conflict and retry`, async () => {
      context = fixture(); rejectSave = '来源已变化'; await render(); await edit(validText())
      await act(async () => button('保存恢复故事规划').click())
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      const first = savedPayload
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow('来源已变化') })
      expect(savedPayload).toEqual(first); expect(container.textContent).toContain('来源已变化'); noModel()
    })
    it(`${kind} exit-save keeps later input dirty while the snapshot saves`, async () => {
      context = fixture(); await render(); await edit(validText())
      let finish: ((value: unknown) => void) | undefined
      pendingSave = () => new Promise(resolve => { finish = resolve })
      let saving: Promise<void> = Promise.resolve()
      await act(async () => { saving = saveDirtyEditorChangesForExit(session.projectPath); void saving.catch(() => {}) })
      await vi.waitFor(() => expect(finish).toBeDefined())
      await edit(validText() + '\n作者继续输入')
      await act(async () => { finish?.({ success: true }); await expect(saving).rejects.toThrow('保存期间仍有未保存修改') })
      expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
      expect(useEditorStore.getState().tabs[0].savedContent).toBe(validText())
      expect(editor().state.doc.toString()).toContain('作者继续输入'); noModel()
    })
    it(`${kind} in-flight and completion unknown do not send automatic requests`, async () => {
      context = fixture(); context.lastCompositionFinishReason = null
      if (context.blueprintRecovery) context.blueprintRecovery.writeState = 'in-flight'
      context.planningContinuation!.state = 'in-flight'
      await render()
      expect(button('继续生成缺少的章节').disabled).toBe(true)
      await edit(validText())
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} reopening preserves author text and normal ledger settlement cannot clear it`, async () => {
      context = fixture(); await render(); await edit('作者尚未保存的修改')
      await act(async () => {
        openPlanningRecoveryDraft(context, session.projectPath, '恢复稿')
        useEditorStore.getState().setProjectEditorDirty('chapter-card', session.projectPath, false)
      })
      expect(useEditorStore.getState().tabs).toHaveLength(1)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '作者尚未保存的修改', dirty: true })
      expect(useEditorStore.getState().tabs[0].originalContent).toBe(context.blueprintRecovery?.draft); noModel()
    })
    it(`${kind} rejects a save from an old project lease`, async () => {
      context = fixture(); await render(); await edit(validText())
      setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' })
      await act(async () => useProjectStore.setState({ currentProject: { ...project, sessionLease: 'new-lease' } }))
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} explicitly continues zero-prefix with frozen target and original source`, async () => {
      context = fixture(); await render(); noModel()
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'generation:restart'), JSON.stringify({ channels: invoke.mock.calls.map(([name]) => name), history: useWorkflowStore.getState().history.map(run => run.error), visible: container.textContent })).toBe(true))
      const restart = invoke.mock.calls.find(([name]) => name === 'generation:restart')
      expect(restart?.[1]).toEqual(handle)
      expect(restart?.[2]).toMatchObject({ authorInputs: expect.arrayContaining([{ id: 'planning:target-units', text: '600' }]) })
      expect(invoke.mock.calls.some(([name]) => name === channel || name === 'generation:begin' || name === 'generation:execute')).toBe(false)
    })
    it(`${kind} shortcut save follows author recovery and keeps other project drafts`, async () => {
      context = fixture(); await render(); await edit(validText())
      await act(async () => useEditorStore.getState().openFile({ id: 'other', name: 'other', type: 'arch-file', projectKey: 'C:\\other', content: '别的项目草稿', savedContent: '', dirty: true }))
      await act(async () => editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(true))
      expect(useEditorStore.getState().tabs.find(tab => tab.projectKey === 'C:\\other')).toMatchObject({ content: '别的项目草稿', dirty: true }); noModel()
    })
    it(`${kind} no remaining range cannot start an empty action`, async () => {
      context = fixture()
      context.planningContinuation = { sourceHandle: handle, remainingRange: null, targetUnits: 600, state: 'complete' }
      await render()
      expect(button('继续生成缺少的章节').disabled).toBe(true); noModel()
    })
    it(`${kind} source-changed editor preserves raw text and blocks local save`, async () => {
      context = fixture()
      if (context.blueprintRecovery) context.blueprintRecovery.writeState = 'source-changed'
      context.planningContinuation!.state = 'source-changed'
      await render(); await edit(validText())
      await act(async () => { await expect(saveDirtyEditorChangesForExit(session.projectPath)).rejects.toThrow() })
      expect(editor().state.doc.toString()).toBe(validText())
      expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(false); noModel()
    })
    it(`${kind} missing reply retry uses the same source and frozen input`, async () => {
      context = fixture(); await render()
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === 'generation:restart')).toHaveLength(1))
      await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(0))
      await expect.element(button('继续生成缺少的章节')).toBeEnabled()
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === 'generation:restart')).toHaveLength(2))
      const calls = invoke.mock.calls.filter(([name]) => name === 'generation:restart')
      expect(calls[0][1]).toEqual(calls[1][1])
      expect(calls[0][2].authorInputs).toEqual(calls[1][2].authorInputs)
      expect(invoke.mock.calls.some(([name]) => name === 'generation:begin' || name === 'generation:execute')).toBe(false)
    })
    it(`${kind} saves the complete prefix before continuing only the authoritative remainder`, async () => {
      context = fixture()
      context.planningContinuation!.state = 'save-prefix'
      await render(); await edit(validText())
      expect(button('继续生成缺少的章节').disabled).toBe(true)
      pendingSave = async () => {
        context = { ...context, planningContinuation: { sourceHandle: handle, remainingRange: { from: 2, to: 3 }, targetUnits: 600, state: 'ready' } }
        return { success: true }
      }
      await act(async () => button('保存恢复故事规划').click())
      noModel()
      expect(container.textContent).toContain('待完成第 2 至 3 章')
      await act(async () => button('继续生成缺少的章节').click())
      await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'generation:restart')).toBe(true))
      const restart = invoke.mock.calls.find(([name]) => name === 'generation:restart')
      const inputs = JSON.stringify(restart?.[2].authorInputs)
      expect(inputs).toContain('\\"startChapter\\":2')
      expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
    })
    it.each([
      ['zh-CN', '待完成第 6 章，每章目标 600', '第 6 至 6 章'],
      ['en-US', 'Chapter 6 remains.', 'Chapters 6 to 6'],
    ] as const)(`${kind} 只剩一章待完成时（%s）写「第 6 章」，不写成「6 至 6」`, async (locale, expected, wrong) => {
      context = fixture()
      context.planningContinuation!.remainingRange = { from: 6, to: 6 }
      useLocaleStore.setState({ locale })
      await render()
      expect(container.textContent).toContain(expected)
      expect(container.textContent).not.toContain(wrong)
    })
  }
  it.each(['blueprint', 'failure-panel'] as const)('%s opens the same editable recovery draft twice without replacing dirty text', async entry => {
    showCandidate = true
    context = fixture()
    await act(async () => root.render(entry === 'blueprint' ? <StageBlueprint projectKey={session.projectPath} /> : <RunSheet sheet={{ kind: 'run', tab: 'active' }} />))
    await vi.waitFor(() => expect(button('编辑恢复稿')).toBeDefined())
    await act(async () => button('编辑恢复稿').click())
    const tab = useEditorStore.getState().tabs[0]
    expect(tab.planningRecovery?.handle).toEqual(handle)
    await act(async () => useEditorStore.getState().updateTabContent(tab.id, '我已修正的候选'))
    await act(async () => button('编辑恢复稿').click())
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '我已修正的候选', dirty: true })
    noModel()
  })
  it('closing a recovery tab preserves the ordinary blueprint exit-save handler', async () => {
    context = fixture(); await render()
    const recoveryId = useEditorStore.getState().tabs[0].id
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => useEditorStore.getState().openFile({ id: 'ordinary', name: '故事规划', type: 'chapter-card', projectKey: session.projectPath, dirty: true }))
    const ordinary = useEditorStore.getState().tabs.find(tab => !tab.planningRecovery)
    if (!ordinary) throw new Error('Missing ordinary blueprint tab')
    const save = vi.fn(async () => useEditorStore.getState().markTabSaved(ordinary.id))
    const dispose = registerEditorExitSaveHandler({ type: 'chapter-card', projectKey: session.projectPath, save })
    await act(async () => useEditorStore.getState().closeTab(recoveryId))
    await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
    expect(save).toHaveBeenCalledOnce()
    dispose(); noModel()
  })
})
