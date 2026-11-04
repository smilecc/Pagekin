import { useEditorStore } from './editor-store'
import { useProjectStore } from './project-store'
import { useLocaleStore } from './locale-store'

/** 打开内置编辑器 */
export function openBuiltinEditor(
  id: string,
  name: string,
  type: 'chapter-card' | 'character' | 'world-building' | 'version-history' | 'narrative-thread',
  narrativeThreadView?: 'plot-tree' | 'plans',
  chapterNumber?: number,
): void {
  const projectKey = useProjectStore.getState().currentProject?.path
  if (!projectKey) return
  if (type === 'world-building') {
    useEditorStore.getState().openFile({ id: 'config', name: useLocaleStore.getState().text('写作选项', 'Writing options'), type: 'config', projectKey })
    return
  }
  useEditorStore.getState().openFile({
    id,
    name,
    type,
    ...(type === 'narrative-thread'
      ? { narrativeThreadView: narrativeThreadView ?? 'plans' }
      : {}),
    ...(type === 'chapter-card' && chapterNumber !== undefined ? { chapterNumber } : {}),
    projectKey,
  })
}
