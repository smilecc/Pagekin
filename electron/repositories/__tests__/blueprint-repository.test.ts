import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const blueprint: BlueprintData = {
  chapterNumber: 1,
  title: '启程',
  role: '',
  purpose: '',
  keyEvents: '主角发现异常',
  characters: ['主角'],
  suspenseHook: '',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}


function blueprintFor(chapterNumber: number): BlueprintData {
  return {
    ...blueprint,
    chapterNumber,
    title: `第${chapterNumber}章`,
    purpose: '',
    keyEvents: `第${chapterNumber}章发生关键事件`,
  }
}

function createBlueprintDb(filename: string | Buffer = ':memory:'): BetterSqlite3.Database {
  const db = new Database(filename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      role TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      key_events TEXT DEFAULT '',
      characters TEXT DEFAULT '[]',
      suspense_hook TEXT DEFAULT '',
      user_guidance TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      notes_updated_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY,
      characters_arch TEXT DEFAULT ''
    );
    INSERT OR IGNORE INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '', age TEXT DEFAULT '', appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '', background TEXT DEFAULT '', abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '', relationships TEXT DEFAULT '', arc TEXT DEFAULT '', notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '', cs_power_level TEXT DEFAULT '', cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '', cs_key_items TEXT DEFAULT '', cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

beforeEach(() => {
  vi.mocked(getProjectDb).mockReturnValue(null)
})

describe('BlueprintRepository without an opened project DB', () => {
  it('throws for getAll', () => {
    expect(() => BlueprintRepository.getAll()).toThrow('PROJECT_NOT_OPEN')
  })

  it('throws for getByChapter', () => {
    expect(() => BlueprintRepository.getByChapter(1)).toThrow('PROJECT_NOT_OPEN')
  })

  it('throws for count', () => {
    expect(() => BlueprintRepository.count()).toThrow('PROJECT_NOT_OPEN')
  })

  it('throws for upsert', () => {
    expect(() => BlueprintRepository.upsert(blueprint)).toThrow('PROJECT_NOT_OPEN')
  })

  it('throws for upsertMany', () => {
    expect(() => BlueprintRepository.upsertMany([blueprint])).toThrow('PROJECT_NOT_OPEN')
  })
})

describe('BlueprintRepository range commit', () => {
  it('stores current story planning prose without hidden metadata or pending character sync', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      const request = { mode: 'replace-range' as const, operationId: 'current-story-plan', startChapter: 1, endChapter: 1, blueprints: [{ ...blueprint, keyEvents: '动作一。\n动作二。', newCharacterCandidates: [{ name: '旧角色', role: 'minor' as const }] }] }
      const receipt = BlueprintRepository.commitRange(request)
      expect(receipt.snapshot[0]).toMatchObject({ title: blueprint.title, keyEvents: '动作一。\n动作二。', characters: blueprint.characters, role: '', purpose: '', suspenseHook: '' })
      expect(receipt.snapshot[0].newCharacterCandidates).toBeUndefined()
      expect(receipt.characterSyncOperation.status).toBe('completed')
      expect(BlueprintRepository.getAll()[0]).toMatchObject({ keyEvents: '动作一。\n动作二。', characters: blueprint.characters })
      expect(BlueprintRepository.commitRange(request)).toMatchObject({ idempotent: true, snapshot: receipt.snapshot })
      expect(BlueprintRepository.getCommittedRangeOperation(request.operationId)?.snapshot).toEqual(receipt.snapshot)
      expect(BlueprintRepository.getCharacterSyncOperation(receipt.characterSyncOperation.operationId)?.status).toBe('completed')
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([])
    } finally { db.close() }
  })

  it('guards a new formal effect inside its transaction and keeps acknowledged replay read-only', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    const request = { mode: 'replace-range' as const, operationId: 'main-guarded', startChapter: 1, endChapter: 1, blueprints: [blueprintFor(1)] }
    try {
      const refuse = () => { expect(db.inTransaction).toBe(true); throw new Error('GENERATION_SOURCE_CHANGED') }
      expect(() => BlueprintRepository.commitRange(request, refuse)).toThrow('GENERATION_SOURCE_CHANGED')
      expect(BlueprintRepository.count()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
      const allow = vi.fn(() => expect(db.inTransaction).toBe(true))
      expect(BlueprintRepository.commitRange(request, allow).idempotent).toBe(false)
      db.prepare("UPDATE blueprints SET title='作者后来编辑的标题' WHERE chapter_number=1").run()
      const replay = BlueprintRepository.commitRange(request, refuse)
      expect(replay.idempotent).toBe(true)
      expect(replay.snapshot[0].title).toBe('作者后来编辑的标题')
      expect(allow).toHaveBeenCalledTimes(1)
    } finally { db.close() }
  })
  it('commits one exact logical range and returns its transaction readback receipt', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })

      expect(receipt).toMatchObject({
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 3,
        chapterNumbers: [1, 2, 3],
        snapshot: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        characterSyncInput: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        idempotent: false,
        characterSyncOperation: {
          operationId: 'blueprint-sync-directory-run-1',
          blueprintCommitOperationId: 'directory-run-1',
          status: 'completed',
          startChapter: 1,
          endChapter: 3,
          characterSyncInput: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        },
      })
      expect(receipt.payloadHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(BlueprintRepository.getAll()).toEqual(receipt.snapshot)
    } finally {
      db.close()
    }
  })

  it('rolls back the whole logical range when transaction readback does not match', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    db.prepare(`
      CREATE TRIGGER rewrite_second_blueprint
      AFTER INSERT ON blueprints
      WHEN NEW.chapter_number = 2
      BEGIN
        UPDATE blueprints SET title = '数据库改写' WHERE chapter_number = 2;
      END
    `).run()

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-rollback',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })).toThrow('BLUEPRINT_COMMIT_READ_BACK_FAILED')
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects missing, duplicate, and out-of-range coverage before opening a transaction', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      for (const blueprints of [
        [blueprintFor(1), blueprintFor(3)],
        [blueprintFor(1), blueprintFor(2), blueprintFor(2)],
        [blueprintFor(1), blueprintFor(2), blueprintFor(4)],
      ]) {
        expect(() => BlueprintRepository.commitRange({
          mode: 'replace-range',
          operationId: 'directory-run-invalid',
          startChapter: 1,
          endChapter: 3,
          blueprints,
        })).toThrow('BLUEPRINT_COMMIT_RANGE_INCOMPLETE')
      }
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects a non-positive chapter range before any write', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-invalid-range',
        startChapter: 0,
        endChapter: 1,
        blueprints: [blueprintFor(0), blueprintFor(1)],
      })).toThrow('BLUEPRINT_COMMIT_RANGE_INVALID')
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('full mode removes old blueprints outside the newly committed complete range', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(blueprintFor))

    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-full-3',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })

      expect(receipt.mode).toBe('full')
      expect(BlueprintRepository.getAll().map(item => item.chapterNumber)).toEqual([1, 2, 3])
    } finally {
      db.close()
    }
  })

  it('rolls back full-mode outside-range deletion when readback validation fails', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    const original = [1, 2, 3, 4, 5].map(chapterFor => ({
      ...blueprintFor(chapterFor),
      title: `原第${chapterFor}章`,
    }))
    BlueprintRepository.upsertMany(original)
    db.prepare(`
      CREATE TRIGGER rewrite_full_second_blueprint
      AFTER UPDATE ON blueprints
      WHEN NEW.chapter_number = 2
      BEGIN
        UPDATE blueprints SET title = '数据库改写' WHERE chapter_number = 2;
      END
    `).run()

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-full-rollback',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })).toThrow('BLUEPRINT_COMMIT_READ_BACK_FAILED')
      expect(BlueprintRepository.getAll()).toEqual(original)
    } finally {
      db.close()
    }
  })

  it('replace-range mode changes only the exact range and preserves outside chapters', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(blueprintFor))
    const replacements = [2, 3].map(chapterNumber => blueprintFor(chapterNumber))
      .map(item => ({ ...item, title: `${item.title}（替换）` }))

    try {
      BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-range-2-3',
        startChapter: 2,
        endChapter: 3,
        blueprints: replacements,
      })

      expect(BlueprintRepository.getAll().map(item => item.title)).toEqual([
        '第1章',
        '第2章（替换）',
        '第3章（替换）',
        '第4章',
        '第5章',
      ])
    } finally {
      db.close()
    }
  })

  it('replays the same operation and payload idempotently but rejects payload reuse', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    const request = {
      mode: 'replace-range' as const,
      operationId: 'directory-replay',
      startChapter: 1,
      endChapter: 2,
      blueprints: [
        blueprintFor(1),
        blueprintFor(2),
      ],
    }

    try {
      const first = BlueprintRepository.commitRange(request)
      const replay = BlueprintRepository.commitRange(request)

      expect(first.idempotent).toBe(false)
      expect(replay).toMatchObject({
        operationId: request.operationId,
        payloadHash: first.payloadHash,
        idempotent: true,
        chapterNumbers: [1, 2],
        characterSyncInput: request.blueprints,
      })
      expect(() => BlueprintRepository.commitRange({
        ...request,
        blueprints: [blueprintFor(1), { ...blueprintFor(2), title: '冲突载荷' }],
      })).toThrow('BLUEPRINT_OPERATION_CONFLICT')
    } finally {
      db.close()
    }
  })

  it('rejects an unknown sync operation instead of manufacturing a completion receipt', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      expect(() => BlueprintRepository.completeCharacterSyncOperation('blueprint-sync-forged'))
        .toThrow('BLUEPRINT_CHARACTER_SYNC_OPERATION_MISSING')
    } finally {
      db.close()
    }
  })

  it('clears durable sync work together with the blueprint facts it belongs to', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-before-clear',
        startChapter: 1,
        endChapter: 1,
        blueprints: [blueprintFor(1)],
      })

      BlueprintRepository.clearAll()

      expect(BlueprintRepository.getAll()).toEqual([])
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([])
      expect(BlueprintRepository.getCharacterSyncOperation(
        receipt.characterSyncOperation.operationId,
      )).toBeNull()
    } finally {
      db.close()
    }
  })
})
