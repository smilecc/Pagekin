import { describe, expect, it } from 'vitest'
import { deriveStages, type WorkFacts } from '../stage-progress'

const facts = (total: number, numbers: number[]): WorkFacts => ({
  config: { coreOutline: '', genre: '悬疑', targetAudience: '成年读者', totalChapters: total, wordsPerChapter: 3000 },
  architecture: {}, blueprints: numbers.map(chapterNumber => ({ chapterNumber, title: '' })), drafts: {}, runningChapters: new Set(),
})

describe('chapter planning progress', () => {
  it('shows partial progress until every planned chapter is covered', () => {
    expect(deriveStages(facts(10, [1, 2])).find(stage => stage.stage === 'blueprint')).toEqual({
      stage: 'blueprint', planned: 2, total: 10, progress: { state: 'active', ratio: 0.2 },
    })
  })
  it('does not count duplicate, prologue or invalid chapter numbers', () => {
    expect(deriveStages(facts(10, [1, 1, 0, -1, 1.5, 2])).find(stage => stage.stage === 'blueprint')).toMatchObject({ planned: 2, total: 10 })
  })
  it('uses an honest denominator when the configured total is smaller than the existing plan', () => {
    expect(deriveStages(facts(1, [1, 2])).find(stage => stage.stage === 'blueprint')).toMatchObject({ planned: 2, total: 2, progress: { state: 'done' } })
  })
  it('keeps an empty plan unstarted', () => {
    expect(deriveStages(facts(0, [])).find(stage => stage.stage === 'blueprint')).toMatchObject({ planned: 0, total: 0, progress: { state: 'todo' } })
  })
  it('keeps outline completion separate from writing options', () => {
    const stages = deriveStages(facts(10, []))
    expect(stages.find(stage => stage.stage === 'outline')?.progress.state).toBe('todo')
    expect(stages.find(stage => stage.stage === 'architecture')?.progress.state).toBe('done')
  })
})
