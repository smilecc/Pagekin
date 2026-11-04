import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { LLMHistoryRepository } from '../../repositories/llm-repository'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { getProjectDb } from '../../database'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const USAGE = { promptTokens: 40, completionTokens: 12, totalTokens: 52, reasoningTokens: null, accounting: 'unknown' as const, totalIncludesReasoning: false, trusted: true }

function fixture(dispatch: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/model-change-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  const projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global')
  fs.mkdirSync(projectStorageRoot); fs.mkdirSync(globalDataRoot)
  const db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockImplementation(() => db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保持原文')")
  // 与用户现场一致：硅基流动的同一个模型条目，途中只改了模型名。
  const model: ModelProfile = { id: 'model', name: '硅基流动', provider: 'openai', protocol: 'openai',
    modelName: 'deepseek-ai/DeepSeek-V4-Flash', apiKey: 'synthetic-private-key', baseUrl: 'https://api.siliconflow.cn/v1',
    temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } }
  const sourceDeps = { db, projectStorageRoot, globalDataRoot,
    readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill }
  const owner = createMainGenerationOwner({ database: db, projectId: 'project', epoch: 'epoch-1', assertCurrent: () => {},
    leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps, { ...selection, projectId: 'project', epoch: 'epoch-1',
      modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, 'epoch-1', modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding,
  })
  cleanups.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const selection: BeginGenerationRequest = { operation: 'generate-world-building', uiActionNonce: 'world', modelId: model.id,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['world_building'], skillStages: ['planning'], output: 'visible-text',
    authorInputs: [{ id: 'architecture:author-config', text: JSON.stringify({ totalChapters: 3 }) },
      { id: 'architecture:planning-intent', text: JSON.stringify({ version: 'architecture-action-v1', priorSteps: ['worldbuilding'], synopsisRange: null }) }] }
  return { db, model, owner, selection }
}

function worldTask(): GenerationTask {
  return { purpose: 'generate-world-building', output: 'visible-text', reasoningStage: 'planning', messages: [{ role: 'user', content: '原始作者事实' }] }
}

function worldDispatch() {
  return vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: '世界观原始候选' })
    return { finishReason: 'stop', usage: USAGE }
  })
}

async function generateFirstWorldbuilding(f: ReturnType<typeof fixture>) {
  const run = f.owner.begin(f.selection)
  await f.owner.execute({ handle: run.handle, invocationNonce: 'world-1', task: worldTask() })
  return run.handle
}

it('作者途中在设置里改了模型名：下一次请求拒绝发送，并明确报告是模型设置变了', async () => {
  const dispatch = worldDispatch(), f = fixture(dispatch)
  const handle = await generateFirstWorldbuilding(f)
  f.model.modelName = 'deepseek-ai/DeepSeek-V4.1-Flash'
  await expect(f.owner.execute({ handle, invocationNonce: 'chapter-2', task: worldTask() }))
    .rejects.toThrow(/^GENERATION_SOURCE_CHANGED_MODEL$/)
  expect(dispatch).toHaveBeenCalledTimes(1)
  // 已生成的世界观候选仍在运行记录里，不会因为拒绝而丢失。
  expect(f.owner.read(handle).artifacts.map(item => item.text).join('')).toContain('世界观原始候选')
})

it('作品设定途中被改：仍报告通用的来源已变，不误报成模型变化', async () => {
  const dispatch = worldDispatch(), f = fixture(dispatch)
  const handle = await generateFirstWorldbuilding(f)
  f.db.prepare("UPDATE project_core SET global_guidance='改过的全局要求' WHERE id='main'").run()
  await expect(f.owner.execute({ handle, invocationNonce: 'chapter-2', task: worldTask() }))
    .rejects.toThrow(/^GENERATION_SOURCE_CHANGED$/)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('模型与作品设定途中都被改：报告通用的来源已变，不只说模型变了', async () => {
  const dispatch = worldDispatch(), f = fixture(dispatch)
  const handle = await generateFirstWorldbuilding(f)
  f.model.modelName = 'deepseek-ai/DeepSeek-V4.1-Flash'
  f.db.prepare("UPDATE project_core SET global_guidance='改过的全局要求' WHERE id='main'").run()
  await expect(f.owner.execute({ handle, invocationNonce: 'chapter-2', task: worldTask() }))
    .rejects.toThrow(/^GENERATION_SOURCE_CHANGED$/)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('主进程每发出一次模型请求，运行侧页的 AI 调用记录就多一条', async () => {
  let fail = false
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
    if (fail) throw new Error('GENERATION_PROVIDER_FAILED')
    options.onVisible({ kind: 'delta', text: '世界观原始候选' })
    return { finishReason: 'stop', usage: USAGE }
  })
  const f = fixture(dispatch)
  const handle = await generateFirstWorldbuilding(f)
  fail = true
  await f.owner.execute({ handle, invocationNonce: 'chapter-2', task: worldTask() }).catch(() => undefined)

  expect(dispatch).toHaveBeenCalledTimes(2)
  expect(LLMHistoryRepository.getStats()).toMatchObject({ totalCalls: 2, successfulCalls: 1, failedCalls: 1 })
  const history = LLMHistoryRepository.getHistory(10) as { purpose: string; success: number }[]
  expect(history.map(call => call.purpose).sort()).toEqual(['generate-world-building', 'generate-world-building'])
  expect(history.find(call => call.success === 1)).toMatchObject({
    modelId: 'model', modelName: '硅基流动', promptTokens: 40, completionTokens: 12, totalTokens: 52, success: 1 })
  expect(history.find(call => call.purpose === 'generate-world-building')).toMatchObject({ success: 0 })
})

/** 请求发出后一直挂起，直到生成被中止才以 GENERATION_CANCELLED 结束。 */
function hangingDispatch() {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>((_request, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('GENERATION_CANCELLED')), { once: true })
    markStarted()
  }))
  return { dispatch, started }
}

const callRows = (db: InstanceType<typeof Database>) =>
  db.prepare('SELECT purpose, success FROM llm_calls ORDER BY id').all() as { purpose: string, success: number }[]

it('生成途中关闭作品：已发出的请求在关库前记入调用记录，重新打开作品仍能看到', async () => {
  const { dispatch, started } = hangingDispatch(), f = fixture(dispatch)
  const run = f.owner.begin(f.selection)
  const pending = f.owner.execute({ handle: run.handle, invocationNonce: 'chapter-1', task: worldTask() }).catch(() => undefined)
  await started

  f.owner.suspendForProjectClose()
  const dbPath = f.db.name
  f.db.close()
  await pending

  const reopened = new Database(dbPath, { readonly: true })
  try {
    expect(callRows(reopened)).toEqual([{ purpose: 'generate-world-building', success: 0 }])
  } finally { reopened.close() }
})

it('生成途中切换作品会话（库不关）：中断的请求只记一次，不在请求结束后再记第二次', async () => {
  const { dispatch, started } = hangingDispatch(), f = fixture(dispatch)
  const run = f.owner.begin(f.selection)
  const pending = f.owner.execute({ handle: run.handle, invocationNonce: 'chapter-1', task: worldTask() }).catch(() => undefined)
  await started

  f.owner.suspendForProjectClose()
  await pending

  expect(callRows(f.db)).toEqual([{ purpose: 'generate-world-building', success: 0 }])
})

/** 与真实 dispatchProvider 一致：请求被中止时服务商回调 onError，再以 GENERATION_PROVIDER_FAILED 拒绝。 */
function providerLikeDispatch(onStart?: (options: Parameters<GenerationRunServiceDependencies['dispatch']>[1]) => void) {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>((_request, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('GENERATION_PROVIDER_FAILED')), { once: true })
    markStarted()
    onStart?.(options)
  }))
  return { dispatch, started }
}

const historyRows = () => LLMHistoryRepository.getHistory(10) as { purpose: string, success: number, finishReason: string | null }[]

it('作者取消生成：AI 调用记录记为已取消，不记成服务商失败', async () => {
  const { dispatch, started } = providerLikeDispatch(), f = fixture(dispatch)
  const run = f.owner.begin(f.selection)
  const pending = f.owner.execute({ handle: run.handle, invocationNonce: 'chapter-1', task: worldTask() }).catch(() => undefined)
  await started

  f.owner.cancel(run.handle)
  await pending
  await vi.waitFor(() => expect(historyRows()).toHaveLength(1))

  expect(historyRows()).toMatchObject([{ purpose: 'generate-world-building', success: 0, finishReason: 'cancelled' }])
})

it('服务商流不合规被中止：调用记录仍是失败，不误记成已取消', async () => {
  const { dispatch, started } = providerLikeDispatch(options => options.onVisible({ kind: 'delta', text: '<think>泄露的推理' }))
  const f = fixture(dispatch)
  const run = f.owner.begin(f.selection)
  const pending = f.owner.execute({ handle: run.handle, invocationNonce: 'chapter-1', task: worldTask() }).catch(() => undefined)
  await started
  await pending
  await vi.waitFor(() => expect(historyRows()).toHaveLength(1))

  expect(historyRows()).toMatchObject([{ purpose: 'generate-world-building', success: 0, finishReason: null }])
})

it('请求用完本次运行的总时长被中止：调用记录记为已取消，不记成服务商失败', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  cleanups.push(() => vi.useRealTimers())
  const { dispatch, started } = providerLikeDispatch(), f = fixture(dispatch)
  const run = f.owner.begin(f.selection)
  const pending = f.owner.execute({ handle: run.handle, invocationNonce: 'chapter-1', task: worldTask() }).catch(error => error)
  await started

  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(JSON.stringify(await pending)).toContain('ROOT_BUDGET_EXHAUSTED')
  vi.useRealTimers()
  await vi.waitFor(() => expect(historyRows()).toHaveLength(1))

  expect(historyRows()).toMatchObject([{ purpose: 'generate-world-building', success: 0, finishReason: 'cancelled' }])
})
