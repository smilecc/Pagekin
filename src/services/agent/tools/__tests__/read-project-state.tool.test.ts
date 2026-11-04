import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { readProjectStateTool } from '../read-project-state.tool'

const invoke = vi.fn()
vi.mock('../../../ipc-client', () => ({
  ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args) },
}))

beforeEach(() => {
  invoke.mockImplementation(async (_session, channel: string) => {
    if (channel === 'db:project-core-get') {
      return {
        projectName: 'Signal Harbor', genre: '科幻', subGenre: 'near future',
        targetAudience: '全龄', totalChapters: 10, wordsPerChapter: 3000,
        plotStructure: '三幕式', narrativePov: '第三人称限知', writingStyle: 'restrained',
      }
    }
    if (channel === 'db:blueprint-get-all') {
      return [{ chapterNumber: 2, title: 'The Broken Beacon', notes: 'Mara finds the altered log.' }]
    }
    throw new Error(`unexpected channel ${channel}`)
  })
  useProjectStore.setState({
    currentProject: {
      id: 'project-en', sessionLease: 'lease-en', name: 'Signal Harbor', path: 'C:\\novels\\signal-harbor',
      novelConfig: { writingLanguage: 'en-US' },
    } as never,
  })
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
})

describe('read_project_state language boundary', () => {

  it('keeps the existing Chinese project-state copy', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-zh', sessionLease: 'lease-zh', name: '信号港', path: 'C:\\novels\\signal-harbor-zh',
        novelConfig: { writingLanguage: 'zh-CN' },
      } as never,
    })
    invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:project-core-get') {
        return {
          projectName: '信号港', genre: '科幻', subGenre: '近未来', targetAudience: '全龄',
          totalChapters: 10, wordsPerChapter: 3000, plotStructure: '三幕式',
          narrativePov: '第三人称限知', writingStyle: '克制',
        }
      }
      if (channel === 'db:blueprint-get-all') return []
      throw new Error(`unexpected channel ${channel}`)
    })

    const result = await readProjectStateTool.execute({}, createAgentExecutionContext())

    expect(result.content).toContain('# 📊 项目状态：《信号港》')
    const configJson = result.content.match(/```json\n([\s\S]+?)\n```/u)?.[1]
    expect(JSON.parse(configJson ?? '{}')).toMatchObject({
      genre: '科幻', targetAudience: '全龄', plotStructure: '三幕式', narrativePOV: '第三人称限知',
    })
    expect(result.content).toContain('## 近章要点')
    expect(result.content).toContain('暂无章节要点。章节要点会在定稿后自动生成并写入蓝图。')
  })
})
