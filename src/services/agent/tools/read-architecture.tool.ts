/**
 * read_architecture — 读取故事架构文件
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject, agentToolErrorDetail } from './project-context'
import { pluralEn } from '../../../shared/plural-en'


export const readArchitectureTool = buildAgentTool({
  name: 'read_architecture',
  description: '读取小说的故事架构文件（大纲、世界观、角色名单、文风、全局写作要求）。是理解小说全局结构的核心工具。',
  descriptionEn: 'Read the story architecture, including the outline, worldbuilding, cast, style, and writing guidance.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_name: {
        type: 'string',
        description: '架构文件名（可选）。不填则列出所有架构文件。例如 "大纲.md"、"世界观.md"',
        descriptionEn: 'Optional architecture file name. Omit it to list all architecture files, for example "outline.md" or "worldbuilding.md"',
      },
      offset: {
        type: 'number',
        description: '可选。从完整结果的第几个字符开始返回，默认 0。结果过长被截断时，按截断提示给出的 offset 继续读取。',
        descriptionEn: 'Optional character position in the complete result to start from. Defaults to 0. When a result is truncated, use the offset given in the truncation note to read the next part.',
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const fileName = args.file_name as string | undefined
    const offset = args.offset === undefined ? 0 : args.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      return { success: false, content: '', error: text('offset 必须是非负整数', 'offset must be a non-negative integer') }
    }
    const fromOffset = (full: string) => offset > 0 && offset >= full.length
      ? { success: true, content: text(
        `offset=${offset} 已超出内容范围：完整内容共 ${full.length} 字符，已全部读完。`,
        `offset=${offset} is past the end: the complete content is ${full.length} characters and has been read in full.`,
      ) }
      : { success: true, content: full.slice(offset), resultOffset: offset }

    try {
      const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', project.path)
      assertAgentProjectCurrent(context)
      if (!core) {
        return { success: false, content: '', error: text('项目架构未初始化', 'The project architecture has not been initialized') }
      }

      if (fileName) {
        // Find property based on suffix
        const isStyle = fileName.includes('文风') || fileName.includes('style')
        const isGuidance = fileName.includes('写作要求') || fileName.includes('guidance')
        const isWorld = fileName.includes('世界') || fileName.includes('world')
        const isChar = fileName.includes('角色') || fileName.includes('character')
        const isSynopsis = fileName.includes('大纲') || fileName.includes('outline')
        let property = ''
        if (isStyle) property = project.novelConfig.writingStyle || ''
        else if (isGuidance) property = project.novelConfig.globalGuidance || ''
        else if (isWorld) property = core.worldbuilding
        else if (isChar) property = core.charactersArch
        else if (isSynopsis) property = project.novelConfig.coreOutline || ''

        if (!property) {
          return { success: false, content: '', error: text(`架构文件内容为空：${fileName}`, `The architecture content is empty: ${fileName}`) }
        }
        return fromOffset(text(`📐 架构文件：${fileName}\n\n${property}`, `📐 Architecture: ${fileName}\n\n${property}`))
      }

      const contents: string[] = []
      if (project.novelConfig.coreOutline) contents.push(`## 📄 outline.md\n\n${project.novelConfig.coreOutline}`)
      if (core.worldbuilding) contents.push(`## 📄 worldbuilding.md\n\n${core.worldbuilding}`)
      if (core.charactersArch) contents.push(`## 📄 characters.md\n\n${core.charactersArch}`)
      if (project.novelConfig.writingStyle) contents.push(`## 📄 style.md\n\n${project.novelConfig.writingStyle}`)
      if (project.novelConfig.globalGuidance) contents.push(`## 📄 guidance.md\n\n${project.novelConfig.globalGuidance}`)

      if (contents.length === 0) {
        return { success: true, content: text('⚠️ 架构为空，暂无架构文件。建议通过工作流生成故事架构。', '⚠️ The architecture is empty. Generate the story architecture with the workflow first.') }
      }

      return fromOffset(text(`📐 故事架构（${contents.length} 个文件）\n\n${contents.join('\n\n---\n\n')}`, `📐 Story architecture (${contents.length} ${pluralEn(contents.length, 'file')})\n\n${contents.join('\n\n---\n\n')}`))
    } catch (error) {
      const detail = agentToolErrorDetail(context, error)
      return {
        success: false,
        content: '',
        error: detail ? text(`读取架构失败：${detail}`, `Could not read the architecture: ${detail}`) : text('读取架构失败', 'Could not read the architecture'),
      }
    }
  },
})
