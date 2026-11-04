import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeLegacyNormalizationFixture as closeProjectDatabase, openLegacyNormalizationFixture } from '../../test/helpers/legacy-baseline-fixture'

// Historical normalization regressions use an explicit fixture handle. Production
// rejects these unqualified old roots; canonical activation is tested separately.
vi.mock('../database', async () => {
  const actual = await vi.importActual<typeof import('../database')>('../database')
  const fixture = await import('../../test/helpers/legacy-baseline-fixture')
  return { ...actual, getProjectDb: fixture.getLegacyNormalizationFixtureDb, getCurrentProjectPath: fixture.getLegacyNormalizationFixturePath }
})
import { ProjectCoreRepository } from '../repositories/project-core-repository'

const roots: string[] = []

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project UTF-8 persistence', () => {
  it('round-trips mixed UTF-8 project facts byte-for-byte across close and reopen', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-writing-language-utf8-'))
    roots.push(projectRoot)
    const projectName = 'Night Café 夜航'
    const coreOutline = 'The sign reads “夜航 Café” — déjà vu.'
    const worldbuilding = '夜航 Café stays open; Mara asks, “Why now?”'

    openLegacyNormalizationFixture(projectRoot)
    ProjectCoreRepository.init(projectName, 'zh-CN')
    ProjectCoreRepository.update({ coreOutline, worldbuilding })
    closeProjectDatabase()
    openLegacyNormalizationFixture(projectRoot)

    const reopened = ProjectCoreRepository.get()
    expect(reopened).toMatchObject({ projectName, writingLanguage: 'zh-CN', coreOutline, worldbuilding })
    expect(new TextEncoder().encode(reopened!.coreOutline)).toEqual(new TextEncoder().encode(coreOutline))
    expect(new TextEncoder().encode(reopened!.worldbuilding)).toEqual(new TextEncoder().encode(worldbuilding))
  })
})
