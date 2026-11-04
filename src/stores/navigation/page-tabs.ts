import { TEXT_FIELDS, openConfigField } from '../../components/stage/setup/config-fields'
import { ipc } from '../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../components/project-session-gate'
import { toast } from '../../components/ui/Toast'
import { useEditorStore } from '../editor-store'
import { useLocaleStore } from '../locale-store'
import { openBuiltinEditor } from '../open-builtin-editor'
import { useProjectStore } from '../project-store'
import type { ResourcePage, WorkStage } from './navigation-intents'

type Text = (zh: string, en: string) => string

function openConfigDocument(id: string) {
  const project = useProjectStore.getState().currentProject
  const field = TEXT_FIELDS.find(item => item.id === id)
  if (project && field) openConfigField(field, project.path)
}
async function openWorld() {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (!session) return
  const store = useEditorStore.getState()
  const filePath = 'ai-novel://core/worldbuilding'
  const existing = store.tabs.find(tab => tab.filePath === filePath && tab.projectKey === session.projectPath)
  if (existing) { store.setActiveTab(existing.id); return }
  const active = store.activeTabId
  try {
    const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath)
    if (!isProjectSessionCurrent(session) || useEditorStore.getState().activeTabId !== active) return
    store.openFile({ id: `world:${session.projectPath}`, type: 'arch-file', name: useLocaleStore.getState().text('世界观', 'World'), filePath,
      content: core?.worldbuilding ?? '', savedContent: core?.worldbuilding ?? '', projectKey: session.projectPath })
  } catch {
    if (isProjectSessionCurrent(session)) toast.error(useLocaleStore.getState().text('读取世界观失败，请重试。', 'Could not load the world. Please retry.'))
  }
}

/** 阶段与资料页对应的标签。正文与知识库没有固定标签，由各自的页面处理。 */
const PAGE_TABS: Partial<Record<WorkStage | ResourcePage, (text: Text) => void>> = {
  outline: () => openConfigDocument('coreOutline'),
  style: () => openConfigDocument('writingStyle'),
  guidance: () => openConfigDocument('globalGuidance'),
  world: () => { void openWorld() },
  cast: text => openBuiltinEditor('character-editor', text('角色名单', 'Cast'), 'character'),
  architecture: text => {
    const projectKey = useProjectStore.getState().currentProject?.path
    if (projectKey) useEditorStore.getState().openFile({ id: 'config', name: text('写作选项', 'Writing options'), type: 'config', projectKey })
  },
  blueprint: text => openBuiltinEditor('chapter-card-editor', text('故事规划', 'Story planning'), 'chapter-card'),
  plot: text => openBuiltinEditor('narrative-thread-editor', text('剧情树与叙事线索', 'Plot tree & narrative threads'), 'narrative-thread', 'plot-tree'),
  history: text => openBuiltinEditor('version-history', text('版本历史', 'Version history'), 'version-history'),
  setup: text => {
    const projectKey = useProjectStore.getState().currentProject?.path
    if (projectKey) useEditorStore.getState().openFile({ id: 'config', name: text('小说配置', 'Novel configuration'), type: 'config', projectKey })
  },
}

export function openPageTab(page: WorkStage | ResourcePage): void {
  PAGE_TABS[page === 'setup' ? 'architecture' : page]?.(useLocaleStore.getState().text)
}
