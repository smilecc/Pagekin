import { WORKFLOW_GENERATION_BUDGETS } from '../base-command'
import { TerminalProviderFailureError } from '../../../generation/generation-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useProjectStore } from '../../../../stores/project-store'
import {
  GenerationAttemptError,
  type GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
} from '../../../generation/generation-harness'
import type { GenerationRuntime } from '../../../generation/generation-runtime'
import {
  DirectoryPostCommitCancellationError,
  GenerateDirectoryCommand,
} from '../directory.command'

type Blueprint = {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  newCharacterCandidates?: Array<{ name: string; role: 'protagonist' | 'antagonist' | 'supporting' | 'minor' }>
  suspenseHook: string
  userGuidance: string
  notes: string
  notesUpdatedAt: string
  relationshipHints: unknown
}

const projectSnapshot = {
  expectedProjectPath: 'C:\\tmp\\vela-test',
  novelConfig: {
    totalChapters: 5,
    globalGuidance: '',
    genre: '玄幻',
  },
}

let authoritySequenceResult: Record<string, unknown>

function workflowContext(): WorkflowContext {
  return {
    runId: 'test-run',
    projectPath: projectSnapshot.expectedProjectPath,
    projectSession: {
      projectId: 'project-1',
      leaseId: 'lease-project-1',
      projectPath: projectSnapshot.expectedProjectPath,
    },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: { architecture: '故事前提'.repeat(30) },
    cancelled: false,
  }
}

function historicalDirectoryContext(): WorkflowContext {
  const context = workflowContext()
  context.data.directoryResumeHandle = { projectId: 'project-1', epoch: 'legacy-epoch', rootActionId: 'frozen-legacy-root', runId: 'frozen-legacy-run' }
  return context
}

function stepCallbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function blueprint(chapterNumber: number, overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    chapterNumber,
    title: `第${chapterNumber}章`,
    role: '发展',
    purpose: `推进第${chapterNumber}章`,
    keyEvents: `第${chapterNumber}章发生关键事件`,
    characters: [],
    relationshipHints: [],
    suspenseHook: `第${chapterNumber}章留下新的悬念`,
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
    ...overrides,
  }
}

function modelBlueprint(chapterNumber: number, overrides: Partial<Blueprint> = {}): Record<string, unknown> {
  const candidate = blueprint(
    chapterNumber,
    { characters: ['主角'], ...overrides },
  )
  return {
    chapterNumber: candidate.chapterNumber,
    title: candidate.title,
    role: candidate.role,
    purpose: candidate.purpose,
    keyEvents: candidate.keyEvents,
    characters: candidate.characters,
    newCharacterCandidates: candidate.newCharacterCandidates,
    relationships: candidate.relationshipHints,
    suspenseHook: candidate.suspenseHook,
  }
}

function blueprintJson(chapterNumbers: readonly number[]): string {
  return JSON.stringify({ blueprints: chapterNumbers.map(chapterNumber => modelBlueprint(chapterNumber)) })
}

function generationReceipt(
  attempt: number,
  finishReason: GenerationAttemptReceipt['finishReason'],
  purpose?: string,
): GenerationAttemptReceipt {
  return {
    ...(purpose ? { purpose } : {}),
    model: {
      id: 'model-1',
      configurationRevision: 'revision-1',
      endpointFingerprint: 'endpoint-1',
    },
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: 4096,
      reasoning: null,
      structuredOutput: true,
      usage: true,
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'legacy-profile',
        featureFlags: 'unknown',
      },
    },
    budget: Object.freeze({
      attempt,
      maxAttempts: 20,
      requestedOutputTokens: 4096,
      cumulativeRequestedOutputTokens: attempt * 4096,
      maxRequestedOutputTokens: 100_000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: Number.MAX_SAFE_INTEGER,
    }),
    finishReason,
  }
}

function generationSession(
  complete: GenerationSession['complete'],
): GenerationSession {
  return {
    budget: Object.freeze({
      maxAttempts: 20,
      maxRequestedOutputTokens: 100_000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: Number.MAX_SAFE_INTEGER,
    }),
    complete,
  }
}

function testRuntime(session: GenerationSession): GenerationRuntime & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {})
  return {
    execute: operation => operation({
      session,
    }),
    close,
  }
}

function taskRange(task: GenerationTask): [number, number] {
  const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
  const match = /第(\d+)章(?:到|至)第(\d+)章/u.exec(prompt)
  const compactMatch = /targetChapterNumber"?\s*:\s*(\d+)/u.exec(prompt)
  if (!match && compactMatch) return [Number(compactMatch[1]), Number(compactMatch[1])]
  if (!match) throw new Error(`missing directory range in prompt: ${prompt}`)
  return [Number(match[1]), Number(match[2])]
}

function stubIpcInvoke(handler: (channel: string, ...args: unknown[]) => unknown) {
  const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(
    channel === 'prompt:load-global' ? { templates: [], diagnostics: [] }
      : channel === 'fs:check-exists' && String(args[0]).endsWith('/.ai-novel/prompts') ? false
        : channel === 'db:draft-authority-sequence' ? authoritySequenceResult
        : handler(channel, ...args),
  ))
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

function successfulCommitHandler(overrides: {
  snapshot?: readonly Blueprint[]
  other?: (channel: string, ...args: unknown[]) => unknown
} = {}) {
  const syncOperations = new Map<string, Record<string, unknown>>()
  return (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-commit-range') {
      const request = args[0] as {
        mode: 'full' | 'replace-range'
        operationId: string
        startChapter: number
        endChapter: number
        blueprints: Blueprint[]
      }
      const snapshot = overrides.snapshot ?? request.blueprints
      const characterSyncInput = snapshot.map(item => (
        item.characters.length === 1
          && item.characters[0] === '主角'
          && Array.isArray(item.relationshipHints)
          && item.relationshipHints.length === 0
          ? { ...item, characters: [] }
          : item
      ))
      const syncOperation = {
        operationId: `blueprint-sync-${request.operationId}`,
        blueprintCommitOperationId: request.operationId,
        blueprintCommitPayloadHash: 'a'.repeat(64),
        status: 'pending',
        startChapter: request.startChapter,
        endChapter: request.endChapter,
        characterSyncInput,
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-01 00:00:00',
      }
      syncOperations.set(syncOperation.operationId, syncOperation)
      return {
        success: true,
        receipt: {
          mode: request.mode,
          operationId: request.operationId,
          payloadHash: 'a'.repeat(64),
          idempotent: false,
          startChapter: request.startChapter,
          endChapter: request.endChapter,
          chapterNumbers: snapshot.map(item => item.chapterNumber),
          snapshot,
          characterSyncInput,
          characterSyncOperation: syncOperation,
        },
      }
    }
    if (channel === 'db:blueprint-character-sync-list-pending') {
      return [...syncOperations.values()].filter(operation => operation.status === 'pending')
    }
    if (channel === 'db:blueprint-character-sync-get') {
      return syncOperations.get(String(args[0])) ?? null
    }
    if (channel === 'db:blueprint-character-sync-complete') {
      const operationId = String(args[0])
      const operation = syncOperations.get(operationId)
      if (!operation) return { success: false, error: 'operation missing' }
      const completionReceipt = {
        blueprintCommitOperationId: operation.blueprintCommitOperationId,
        operationId,
        status: 'already-satisfied',
      }
      const completed = {
        ...operation,
        status: 'completed',
        completionReceipt,
        completedAt: '2026-01-01 00:01:00',
        updatedAt: '2026-01-01 00:01:00',
      }
      syncOperations.set(operationId, completed)
      return { success: true, operation: completed }
    }
    return overrides.other?.(channel, ...args) ?? { success: true }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authoritySequenceResult = {
    status: 'empty',
    lastChapterNumber: 0,
    nextChapterNumber: 1,
    duplicateChapterNumbers: [],
    authorityFingerprint: 'f'.repeat(64),
  }
  useProjectStore.setState({
    currentProject: {
      id: 'project-1',
      name: '测试项目',
      path: projectSnapshot.expectedProjectPath,
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 5,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '',



        globalGuidance: '',
      },
      characterStates: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('GenerateDirectoryCommand', () => {
  it('generates title and planning prose without creating character candidates', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const plan = { chapterNumber: 1, title: '来信', keyEvents: '林岚在码头收到来信。\n她决定追查寄信人。', characters: ['林岚'] }
    const session = generationSession(async task => ({ status: 'completed', content: JSON.stringify({ blueprints: [plan] }), finishReason: 'stop', receipt: generationReceipt(1, 'stop', task.purpose) }))
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot, { createRuntime: vi.fn(async () => testRuntime(session)) })
    const result = await command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() })
    expect(result[0]).toMatchObject(plan)
    expect(result[0].characters).toEqual(['林岚'])
    expect(result[0].role).toBe('')
    expect(invoke.mock.calls.some(([channel]) => /character|proposal/.test(channel))).toBe(false)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
  })

  it('uses finalized authority as the default append start when no explicit range is supplied', async () => {
    authoritySequenceResult = {
      status: 'continuous',
      lastChapterNumber: 9,
      nextChapterNumber: 10,
      duplicateChapterNumbers: [],
      authorityFingerprint: 'a'.repeat(64),
    }
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([10]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 10 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() })

    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({ startChapter: 10, endChapter: 10 })
  })

  it('fails before opening a runtime when finalized authority is discontinuous', async () => {
    authoritySequenceResult = {
      status: 'invalid',
      lastChapterNumber: 9,
      firstGapChapterNumber: 4,
      duplicateChapterNumbers: [],
      authorityFingerprint: 'b'.repeat(64),
    }
    stubIpcInvoke(successfulCommitHandler())
    const createRuntime = vi.fn()
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      projectSnapshot,
      { createRuntime: createRuntime as never },
    )

    await expect(command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() }))
      .rejects.toThrow(/权威定稿缺少第 4 章/u)
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it.each([
    ['author target', 900, false, 900, '630–1170'],
    ['compact fallback target', 1500, true, 1500, '1050–1950'],
    ['rounded author target', 919, false, 919, '643–1195'],
    ['existing default', undefined, false, 3000, '2100–3900'],
  ] as const)('puts the %s chapter capacity at the end of every production request', async (
    _label,
    wordsPerChapter,
    forceCompact,
    expectedTarget,
    expectedRange,
  ) => {
    stubIpcInvoke(successfulCommitHandler())
    const observedTasks: GenerationTask[] = []
    const session = generationSession(async task => {
      observedTasks.push(task)
      const compact = task.purpose.includes(':compact-single:')
      return {
        status: 'completed',
        content: JSON.stringify({
          blueprints: [modelBlueprint(1, {
            title: forceCompact && !compact ? '' : '第一章',
            relationshipHints: forceCompact && !compact
              ? [{ from: '主角', to: '未声明角色', relation: '对手' }]
              : [],
          })],
        }),
        finishReason: 'stop',
        receipt: generationReceipt(observedTasks.length, 'stop', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      {
        ...projectSnapshot,
        novelConfig: {
          ...projectSnapshot.novelConfig,
          totalChapters: 1,
          wordsPerChapter,
        },
      },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() })

    expect(observedTasks).toHaveLength(forceCompact ? 2 : 1)
    for (const task of observedTasks) {
      const user = task.messages.find(message => message.role === 'user')?.content ?? ''
      expect(user).toContain(`每章正文目标约 ${expectedTarget} 字，可接受范围 ${expectedRange} 字`)
      expect(user).toContain('作者指定事件与字数目标均为权威事实，不得删除、改写或擅自调整')
      expect(user).toContain('只计一个语义事件')
      expect(user).toContain('不擅自增加独立事件')
      expect(user).toContain('不得把全部背景逐项演成场景')
      expect(user).toContain('容量冲突：…')
      expect(user.trim().endsWith('不写章节正文。')).toBe(true)
    }
    if (forceCompact) {
      const compactPrompt = observedTasks.at(-1)?.messages.find(message => message.role === 'user')?.content ?? ''
      expect(compactPrompt).toContain(`"targetWordsPerChapter":${expectedTarget}`)
    }
  })





  it('allows a new directory run while an older character sync remains independently retryable', async () => {
    const operation = {
      operationId: 'blueprint-sync-previous-run',
      blueprintCommitOperationId: 'previous-run',
      blueprintCommitPayloadHash: 'a'.repeat(64),
      status: 'pending',
      startChapter: 1,
      endChapter: 2,
      characterSyncInput: [blueprint(1, { characters: ['林岚'] })],
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }
    const commitHandler = successfulCommitHandler()
    stubIpcInvoke((channel, ...args) => (
      channel === 'db:blueprint-character-sync-list-pending'
        ? [operation]
        : commitHandler(channel, ...args)
    ))
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result).toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledOnce()
  })

  it('keeps a larger logical range in one transaction while the executor makes ordered five-item batches', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    let firstPrompt = ''
    const session = generationSession(async task => {
      if (!firstPrompt) firstPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
      const range = taskRange(task)
      observedRanges.push(range)
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(observedRanges.length, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 7 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 7 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(observedRanges).toEqual([[1, 5], [6, 7]])
    expect(firstPrompt).toContain('【故事规划 JSON 合同】')
    for (const field of ['chapterNumber', 'title', 'keyEvents']) {
      expect(firstPrompt).toContain(field)
    }
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledWith({ budget: WORKFLOW_GENERATION_BUDGETS.structured }, expect.objectContaining({
      selection: expect.objectContaining({ operation: 'chapter-blueprint-directory', promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data' }),
    }))
  })

  it('resumes one frozen historical eleven-chapter append with the authoritative bounded cost plan', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    const session = generationSession(async task => {
      const range = taskRange(task)
      observedRanges.push(range)
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(observedRanges.length, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 10, count: 11 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 20 } },
      { createRuntime },
    )

    const result = await command.execute({ step: {}, context: historicalDirectoryContext(), callbacks: stepCallbacks() })

    expect(result.map(item => item.chapterNumber))
      .toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(observedRanges).toEqual([[10, 14], [15, 19], [20, 20]])
    expect(createRuntime).toHaveBeenCalledWith({ budget: WORKFLOW_GENERATION_BUDGETS.structured }, expect.objectContaining({
      selection: expect.objectContaining({ operation: 'chapter-blueprint-directory', promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data' }),
    }))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('commits append generation as an exact replace-range operation', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async task => {
      const range = taskRange(task)
      return {
        status: 'completed',
        content: blueprintJson([range[0], range[1]]),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 2, count: 2 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({
        mode: 'replace-range',
        startChapter: 2,
        endChapter: 3,
        blueprints: [{ chapterNumber: 2 }, { chapterNumber: 3 }],
      })
  })

  it('commits only the validated prefix when a later five-item semantic batch fails', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    let attempt = 0
    const session = generationSession(async () => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'completed',
          content: blueprintJson([1, 2, 3, 4, 5]),
          finishReason: 'stop',
          receipt: generationReceipt(attempt, 'stop'),
        }
      }
      throw new GenerationAttemptError(
        'PROVIDER_REQUEST_FAILED',
        '模型请求失败。',
        generationReceipt(attempt, 'error'),
      )
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 7 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 7 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/已保存第 1–5 章完整蓝图/u)

    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1]).toMatchObject({ mode: 'replace-range', startChapter: 1, endChapter: 5 })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it.each([10, 50, 200])('keeps %s chapters on a frozen historical root without changing its finite budget', async count => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const ranges: Array<[number, number]> = []
    const session = generationSession(async task => {
      const range = taskRange(task)
      ranges.push(range)
      if (ranges.length > 32) throw new Error('ROOT_BUDGET_EXHAUSTED')
      return { status: 'completed', content: blueprintJson(Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i)), finishReason: 'stop', receipt: generationReceipt(ranges.length, 'stop') }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand({ mode: 'full', count }, { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: count } }, { createRuntime })
    const execution = command.execute({ step: {}, context: historicalDirectoryContext(), callbacks: stepCallbacks() })
    if (count === 200) {
      await expect(execution).rejects.toThrow()
      expect(ranges).toHaveLength(33)
      const commits = invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')
      expect(commits).toHaveLength(1)
      expect(commits[0][1]).toMatchObject({ mode: 'replace-range', startChapter: 1, endChapter: 160 })
    } else {
      expect((await execution).map(item => item.chapterNumber)).toEqual(Array.from({ length: count }, (_, i) => i + 1))
      expect(ranges).toHaveLength(count / 5)
      expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
    }
    expect(createRuntime).toHaveBeenCalledOnce()
    const covered = ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i))
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('rejects an append range beyond the project boundary instead of reporting an empty success', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const createRuntime = vi.fn(async () => testRuntime(generationSession(async () => {
      throw new Error('must not generate')
    })))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 6, count: 1 },
      projectSnapshot,
      { createRuntime },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/章节范围无效/u)

    expect(createRuntime).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('splits a five-chapter length outcome into ordered 2+3 batches and commits once', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    const observedPrompts: string[] = []
    const createRuntime = vi.fn(async () => testRuntime(session))
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      const range = taskRange(task)
      observedRanges.push(range)
      observedPrompts.push(task.messages.find(message => message.role === 'user')?.content ?? '')
      if (attempt === 1) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 5 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, wordsPerChapter: 1200 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2, 3, 4, 5])
    expect(observedRanges).toEqual([[1, 5], [1, 2], [3, 5]])
    expect(observedPrompts).toHaveLength(3)
    expect(observedPrompts.every(prompt => (
      prompt.includes('每章正文目标约 1200 字，可接受范围 840–1560 字')
    ))).toBe(true)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledWith({ budget: WORKFLOW_GENERATION_BUDGETS.structured }, expect.objectContaining({
      selection: expect.objectContaining({ operation: 'chapter-blueprint-directory', promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data' }),
    }))
  })

  it('replaces one length-truncated single blueprint in full on the same runtime and commits once', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observed: Array<{ range: [number, number]; purpose: string }> = []
    const authorGuidance = `KEEP-FULL-${'g'.repeat(1_300)}-END`
    const architecture = `${'作者设定：药柜仅作背景。\n'.repeat(450)}药师陆青必须在场；但前述取药计划已撤销。`
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      const range = taskRange(task)
      observed.push({ range, purpose: task.purpose })
      if (task.purpose.includes(':compact-single:')) {
        const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
        expect(prompt).toContain(authorGuidance)
        expect(prompt).toContain('药师陆青必须在场；但前述取药计划已撤销。')
        expect(task.promptBudget).toBeUndefined()
      }
      if (attempt <= 2) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 2 },
      {
        ...projectSnapshot,
        novelConfig: { ...projectSnapshot.novelConfig, globalGuidance: authorGuidance },
      },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: { ...workflowContext(), data: { architecture } },
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2])
    expect(observed).toEqual([
      { range: [1, 2], purpose: 'chapter-blueprint-directory' },
      { range: [1, 1], purpose: 'chapter-blueprint-directory' },
      { range: [1, 1], purpose: 'chapter-blueprint-directory:compact-single:chapter-1' },
      { range: [2, 2], purpose: 'chapter-blueprint-directory' },
    ])
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('passes complete author and writing Skill facts above 32 KiB to the physical capacity owner', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const physicalDispatch = vi.fn()
    const tail = '药师陆青必须在场；但取药计划已撤销。'
    const architecture = `${'药柜只是背景设定。\n'.repeat(450)}${tail}`
    const skillContent = '创作技巧不能改写作者事实。'.repeat(900)
    const context: WorkflowContext = {
      ...workflowContext(), data: { architecture },
      writingSkills: Object.freeze({ planning: Object.freeze({
        skillId: 'user:planning-skill', name: 'Planning craft', stage: 'planning' as const,
        source: 'user' as const, writingLanguage: 'zh-CN' as const,
        content: skillContent, utf8Bytes: new TextEncoder().encode(skillContent).byteLength,
      }) }),
    }
    const session = generationSession(async task => {
      physicalDispatch(task)
      if (task.purpose.includes(':compact-single:')) {
        return { status: 'completed', content: blueprintJson([1]), finishReason: 'stop', receipt: generationReceipt(2, 'stop', task.purpose) }
      }
      return {
        status: 'incomplete', content: '{"blueprints":[', finishReason: 'length',
        receipt: generationReceipt(1, 'length', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    expect(await command.execute({ step: {}, context, callbacks: stepCallbacks() })).toHaveLength(1)
    expect(physicalDispatch).toHaveBeenCalledTimes(2)
    const compact = physicalDispatch.mock.calls[1][0] as GenerationTask
    expect(compact.messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0)).toBeGreaterThan(32_768)
    expect(compact.messages.map(message => message.content).join('\n')).toContain(skillContent)
    expect(compact.messages.map(message => message.content).join('\n')).toContain(tail)
    expect(compact.promptBudget?.limitUtf8Bytes).toBeGreaterThan(32_768)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
  })

  it('commits no directory facts when the single-item replacement is also length-truncated', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const callbacks = stepCallbacks()
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      return {
        status: 'incomplete',
        content: '{"blueprints":[',
        finishReason: 'length',
        receipt: generationReceipt(attempt, 'length', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const failure = await command.execute({
      step: {},
      context: { ...workflowContext(), uiLocale: 'en-US' },
      callbacks,
    }).then(() => null, error => error as Error)

    expect(failure?.message).not.toMatch(/[\u3400-\u9fff]/u)
    expect(failure?.message).toContain('Blueprint generation failed: code=limit_exceeded reason=output_limit')
    expect(failure?.message).toContain(
      'purpose=chapter-blueprint-directory:compact-single:chapter-1 finishReason=length requestedTokens=4096',
    )
    expect(attempt).toBe(2)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining(
      'purpose=chapter-blueprint-directory:compact-single:chapter-1 finishReason=length requestedTokens=4096',
    ))
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it('fails with the registered code when the provider rejects the request as too long', async () => {
    stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async task => {
      throw new TerminalProviderFailureError('GENERATION_CONTEXT_LENGTH_EXCEEDED', generationReceipt(1, 'error', task.purpose))
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) })
    const failure = await command.execute({ step: {}, context: { ...workflowContext(), uiLocale: 'en-US' }, callbacks: stepCallbacks() })
      .then(() => null, error => error as Error)
    expect(failure?.message).toBe('GENERATION_CONTEXT_LENGTH_EXCEEDED')
  })

  it('replays the frozen historical split sequence and recovers chapter 18 with one compact task', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observed: Array<{ range: [number, number]; purpose: string }> = []
    const lengthAttempts = new Set([1, 3, 6, 8, 10, 11])
    const session = generationSession(async task => {
      const attempt = observed.length + 1
      const range = taskRange(task)
      observed.push({ range, purpose: task.purpose })
      if (lengthAttempts.has(attempt)) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[{"chapterNumber":18,"keyEvents":"不可信截断片段',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length', task.purpose),
        }
      }
      if (task.purpose.includes(':compact-single:')) {
        const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
        expect(task.promptBudget).toBeUndefined()
        expect(prompt).not.toContain('不可信截断片段')
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 10, count: 11 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 20 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )
    const context = historicalDirectoryContext()
    context.data.architecture = '极长架构事实。'.repeat(20)

    const result = await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    expect(result.map(item => item.chapterNumber)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(observed).toEqual([
      { range: [10, 14], purpose: 'chapter-blueprint-directory' },
      { range: [10, 11], purpose: 'chapter-blueprint-directory' },
      { range: [12, 14], purpose: 'chapter-blueprint-directory' },
      { range: [12, 12], purpose: 'chapter-blueprint-directory' },
      { range: [13, 14], purpose: 'chapter-blueprint-directory' },
      { range: [15, 19], purpose: 'chapter-blueprint-directory' },
      { range: [15, 16], purpose: 'chapter-blueprint-directory' },
      { range: [17, 19], purpose: 'chapter-blueprint-directory' },
      { range: [17, 17], purpose: 'chapter-blueprint-directory' },
      { range: [18, 19], purpose: 'chapter-blueprint-directory' },
      { range: [18, 18], purpose: 'chapter-blueprint-directory' },
      { range: [18, 18], purpose: 'chapter-blueprint-directory:compact-single:chapter-18' },
      { range: [19, 19], purpose: 'chapter-blueprint-directory' },
      { range: [20, 20], purpose: 'chapter-blueprint-directory' },
    ])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it.each([
    ['zh-CN', '已保存第 1–2 章完整蓝图。第 3–5 章的请求超出了模型能接受的长度，服务商拒绝了，这几章没有生成。'],
    ['en-US', 'Saved complete blueprints for chapters 1–2. The request for chapters 3–5 was longer than the model accepts, so the provider rejected it and those chapters were not generated.'],
  ] as const)('says which chapters were saved and which were not generated when a later split is rejected as too long (%s)', async (uiLocale, expected) => {
    stubIpcInvoke(successfulCommitHandler())
    let attempt = 0
    const session = generationSession(async task => {
      attempt += 1
      if (attempt === 1) return { status: 'incomplete', content: '{"blueprints":[', finishReason: 'length', receipt: generationReceipt(attempt, 'length') }
      if (attempt === 2) return { status: 'completed', content: blueprintJson([1, 2]), finishReason: 'stop', receipt: generationReceipt(attempt, 'stop') }
      throw new TerminalProviderFailureError('GENERATION_CONTEXT_LENGTH_EXCEEDED', generationReceipt(attempt, 'error', task.purpose))
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 5 }, projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) })
    const failure = await command.execute({ step: {}, context: { ...workflowContext(), uiLocale }, callbacks: stepCallbacks() })
      .then(() => null, error => error as Error)
    expect(failure?.message).toContain(expected)
    expect(failure?.message).not.toMatch(/没有生成内容|nothing was generated/u)
  })

  it('commits only the validated prefix when the later split fails after the earlier split validated', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    let attempt = 0
    const session = generationSession(async () => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      if (attempt === 2) {
        return {
          status: 'completed',
          content: blueprintJson([1, 2]),
          finishReason: 'stop',
          receipt: generationReceipt(attempt, 'stop'),
        }
      }
      throw new GenerationAttemptError(
        'PROVIDER_REQUEST_FAILED',
        '模型请求失败。',
        generationReceipt(attempt, 'error'),
      )
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 5 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/已保存第 1–2 章完整蓝图/u)

    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1]).toMatchObject({ mode: 'replace-range', startChapter: 1, endChapter: 2 })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it('requires exact chapter coverage before any database write', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1, 3]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/code=unexpected_item path=blueprints/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })



  it('saves a complete key event beyond the former maximum without consuming rebuild budget', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const complete = vi.fn(async (task: GenerationTask) => {
      if (task.purpose.includes(':compact-single:')) throw new Error('ROOT_BUDGET_EXHAUSTED')
      return {
        status: 'completed',
        content: JSON.stringify({ blueprints: [modelBlueprint(1, {
          keyEvents: `${'事'.repeat(1_200)}但主角已撤销该行动`,
        })] }),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop', task.purpose),
      } as const
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(generationSession(complete))) },
    )

    const result = await command.execute({
      step: {}, context: workflowContext(), callbacks: stepCallbacks(),
    })

    expect(result[0].keyEvents).toBe(`${'事'.repeat(1_200)}但主角已撤销该行动`)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')).toHaveLength(1)
  })





  it('does not synthesize a missing required title in strict generation output', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const missingTitle: Record<string, unknown> = modelBlueprint(1)
    delete missingTitle.title
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [missingTitle] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/code=missing_field path=blueprints\[0\]\.title/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })



  it('returns the single transaction readback snapshot instead of generated pre-commit objects', async () => {
    const readback = [1, 2, 3].map(chapterNumber => blueprint(chapterNumber, {
      title: `第${chapterNumber}章（事务回读）`,
    }))
    const invoke = stubIpcInvoke(successfulCommitHandler({ snapshot: readback }))
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1, 2, 3]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result).toEqual(readback)
    const commitCalls = invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]?.[1]).toMatchObject({
      mode: 'replace-range',
      operationId: 'directory-test-run-1-3',
      startChapter: 1,
      endChapter: 3,
      blueprints: [{ chapterNumber: 1 }, { chapterNumber: 2 }, { chapterNumber: 3 }],
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-get')
  })

  it('cancels before commit and writes nothing', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const context = workflowContext()
    const session = generationSession(async () => {
      context.cancelled = true
      return {
        status: 'completed',
        content: blueprintJson([1, 2, 3]),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({ step: {}, context, callbacks: stepCallbacks() }))
      .rejects.toThrow(/取消/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })







  it('does not report zero-write cancellation when cancellation arrives after the atomic commit', async () => {
    const context = workflowContext()
    const committed = blueprint(1)
    const commitHandler = successfulCommitHandler({ snapshot: [committed] })
    stubIpcInvoke((channel, ...args) => {
      const result = commitHandler(channel, ...args)
      if (channel === 'db:blueprint-commit-range') context.cancelled = true
      return result
    })
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const failure = await command.execute({ step: {}, context, callbacks: stepCallbacks() })
      .catch(error => error as unknown)

    expect(failure).toBeInstanceOf(DirectoryPostCommitCancellationError)
    expect(failure).toMatchObject({ commitReceipt: { chapterNumbers: [1] } })
    expect((failure as Error).message).toContain('蓝图已提交')
  })
})
