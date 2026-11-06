import { useMemo, useState } from 'react'
import { BookOpen, Plus, MoreHorizontal, Sparkles } from 'lucide-react'
import type { DirectoryWorkflowParams } from '../../../services/workflows/directory-workflow'
import { openPlanningRecoveryDraft } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { isCurrentProjectSession, currentProjectSessionForPath, useChapterBlueprints } from '../../editor/use-chapter-blueprints'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { EmptyState } from '../../ui/EmptyState'
import { Menu } from '../../ui/Menu'
import { Notice } from '../../ui/Notice'
import { InkDialog } from '../InkDialog'
import { useStageView } from '../use-stage-work'
import BatchWriteDialog from './BatchWriteDialog'
import BlueprintCard from './BlueprintCard'
import BlueprintPlanList from './BlueprintPlanList'
import GenerateBlueprintsDialog from './GenerateBlueprintsDialog'
import { pluralEn } from '../../../shared/plural-en'

/** 等作者确认的一步：覆盖已有故事规划、生成前的架构警告、清空全部、删除此章、清除误导入正文。 */
type Ask =
  | { kind: 'overwrite' | 'warning'; message?: string; resolve: (ok: boolean) => void }
  | { kind: 'delete'; chapterNumber: number }
  | { kind: 'clear' | 'legacy' }

/**
 * 故事规划阶段：目录、章节名、出场角色与规划正文。正文写作由章节视图负责。
 * 数据来自 useChapterBlueprints；未保存提示只在顶栏，⌘S 走同一个退出前保存。
 */
export default function StageBlueprint({ projectKey, initialChapterNumber, selectRequest }: {
  projectKey: string
  initialChapterNumber?: number
  selectRequest?: number
}) {
  const text = useLocaleStore(s => s.text)
  const plan = useChapterBlueprints({ projectKey, initialChapterNumber, selectRequest })
  const { chapters } = useStageView()
  const rows = useMemo(() => new Map(chapters.map(row => [row.number, row])), [chapters])
  const [generateOpen, setGenerateOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)

  const next = plan.nextWritableBlueprint
  const count = plan.blueprints.length
  const selected = plan.selected
  const deleting = ask?.kind === 'delete' ? ask.chapterNumber : null

  const confirmWith = (kind: 'overwrite' | 'warning', message?: string) =>
    new Promise<boolean>(resolve => setAsk({ kind, message, resolve }))

  const settle = (ok: boolean) => {
    if (ask && 'resolve' in ask) ask.resolve(ok)
    setAsk(null)
  }

  // 确认框不叠在生成对话框上：先收起对话框再问。作者取消时对话框原样回来，不当作错误；启动失败时回来并写明原因。
  const generate = async (params: DirectoryWorkflowParams) => {
    setGenerateOpen(false)
    try {
      const started = params.mode === 'full' && count > 0 && !(await confirmWith('overwrite'))
        ? false
        : await plan.generateBlueprints(params, message => confirmWith('warning', message))
      if (!started) setGenerateOpen(true)
      return started
    } catch (error) {
      setGenerateOpen(true)
      throw error
    }
  }

  const openRecovery = () => {
    const session = currentProjectSessionForPath(projectKey)
    if (plan.planningRecovery && session && isCurrentProjectSession(session)) {
      openPlanningRecoveryDraft(plan.planningRecovery, projectKey, text('故事规划恢复稿', 'Blueprint recovery draft'))
    }
  }

  // 只有第一次读取（含换作品）才整页换成读取中；之后的重新加载保留页面、打开的弹层与对话框，作者的输入不丢。
  if (plan.loading && !plan.projectDataReady) {
    return <div className="stage-bp-loading" role="status">{text('正在读取故事规划…', 'Loading story plans…')}</div>
  }

  if (!plan.projectMatches) {
    return (
      <EmptyState
        icon={<BookOpen aria-hidden />}
        heading={text('这个标签属于另一部作品', 'This tab belongs to another book')}
        description={text('切回原来的作品后继续编辑故事规划。', 'Switch back to that book to keep editing its blueprints.')}
        action={null}
      />
    )
  }

  const generateButton = (
    <Button
      variant="primary"
      disabled={!plan.projectDataReady || Boolean(plan.authorityError)}
      onClick={() => setGenerateOpen(true)}
    >
      <Sparkles size={15} aria-hidden />{text('AI 生成故事规划', 'Generate blueprints')}
    </Button>
  )

  return (
    <div className="stage-bp" aria-busy={plan.loading}>
      <header className="stage-bp-head">
        <div className="stage-bp-heading">
          <h1 className="stage-bp-h1">{text('故事规划', 'Story planning')}</h1>
        </div>
        <div className="stage-bp-actions">
          <Menu
            label={text('更多故事规划操作', 'More blueprint actions')}
            icon={<MoreHorizontal size={16} aria-hidden />}
            align="end"
            groups={[
              { id: 'edit', items: [
                { id: 'save-all', label: text('保存全部', 'Save all'), onSelect: () => void plan.saveAll(), disabled: !plan.dirty || plan.saving },
                { id: 'reload', label: text('重新加载故事规划', 'Reload blueprints'), onSelect: () => void plan.reload() },
                { id: 'batch', label: text('批量创作…', 'Batch write…'), onSelect: () => setBatchOpen(true), disabled: !next },
              ] },
              { id: 'danger', tone: 'danger', label: text('危险', 'Danger'), items: [
                { id: 'clear', label: text('清空全部故事规划…', 'Clear all blueprints…'), onSelect: () => setAsk({ kind: 'clear' }),
                  disabled: plan.saving || count === 0 || !plan.projectDataReady },
              ] },
            ]}
          />
          <Button variant="secondary" onClick={plan.addChapter} disabled={!plan.projectDataReady || plan.nextWriteChapter === null || Boolean(plan.authorityError)}>
            <Plus size={15} aria-hidden />{text('新建章节', 'New chapter')}
          </Button>
          {count > 0 && generateButton}
        </div>
      </header>

      {plan.planningRecovery && (
        <Notice
          tone="info"
          title={text('有一份故事规划恢复稿', 'A blueprint recovery draft is available')}
          actions={<Button variant="secondary" size="sm" onClick={openRecovery}>{text('编辑恢复稿', 'Edit recovery draft')}</Button>}
        >
          {text('上次生成故事规划时中断，恢复出了一部分。列表里仍是原来的故事规划；保存恢复稿才会替换，也可以在恢复稿里接着生成缺少的章节。',
            'The last blueprint generation stopped partway. The list still shows the original blueprints; saving the recovery draft replaces them, and you can generate the missing chapters from there.')}
        </Notice>
      )}

      {plan.legacyImportedTextRecoveryChapter !== null && (
        <Notice
          tone="warn"
          title={text(`第 ${plan.legacyImportedTextRecoveryChapter} 章还没写，后面却已有正文`, `Chapter ${plan.legacyImportedTextRecoveryChapter} is unwritten, but later chapters have text`)}
          actions={(
            <Button variant="danger" size="sm" disabled={plan.recoveringLegacyImportedText} onClick={() => setAsk({ kind: 'legacy' })}>
              {plan.recoveringLegacyImportedText ? text('清除中…', 'Clearing…') : text('清除误导入正文…', 'Clear imported text…')}
            </Button>
          )}
        >
          {text('这可能是旧版「小说拆解与仿写」误导入的参考原文。不会自动清除任何内容。',
            'This may be reference text imported by mistake by the old “Novel breakdown & imitation”. Nothing is cleared automatically.')}
        </Notice>
      )}

      {plan.projectDataReady && plan.authorityError && plan.legacyImportedTextRecoveryChapter === null && (
        <Notice tone="warn" title={text('暂时无法确定下一章', 'The next chapter cannot be determined')}>{plan.authorityError}</Notice>
      )}

      {count === 0 ? (
        <div className="stage-bp-empty">
          <EmptyState
            icon={<BookOpen aria-hidden />}
            heading={text('还没有故事规划', 'No story plans yet')}
            description={text('根据大纲、世界观与角色名单生成各章规划，也可以点击「新建章节」开始编写。',
              'Generate chapter plans from the outline, worldbuilding and characters, or choose “New chapter” to start planning yourself.')}
            action={generateButton}
          />
        </div>
      ) : (
        <div className="stage-bp-body">
          <BlueprintPlanList
            blueprints={plan.blueprints}
            rows={rows}
            selectedIdx={plan.selectedIdx}
            nextWriteChapter={plan.nextWriteChapter}
            onSelect={plan.setSelectedIdx}
          />
          {selected && (
            <BlueprintCard
              projectKey={projectKey}
              blueprint={selected}
              saving={plan.saving}
              onField={plan.updateField}
              onSave={() => void plan.saveOne()}
              onDelete={() => setAsk({ kind: 'delete', chapterNumber: selected.chapterNumber })}
            />
          )}
        </div>
      )}

      <GenerateBlueprintsDialog
        isOpen={generateOpen}
        onClose={() => setGenerateOpen(false)}
        existingCount={count}
        onConfirm={generate}
      />
      <BatchWriteDialog
        isOpen={batchOpen}
        startChapterNumber={next?.chapterNumber ?? null}
        onClose={() => setBatchOpen(false)}
      />

      <DangerConfirm
        open={ask?.kind === 'overwrite'}
        onOpenChange={open => { if (!open) settle(false) }}
        title={text('覆盖已有故事规划？', 'Overwrite existing blueprints?')}
        consequence={text(`将从第 1 章起重新生成，已有的 ${count} 章故事规划会被新故事规划替换。草稿与正文不受影响。`,
          `Generation restarts from chapter 1 and replaces the ${count} existing ${pluralEn(count, 'blueprint')}. Drafts and manuscript chapters are not affected.`)}
        recoverability={text('被替换的故事规划无法恢复。只想补空缺时，选「保留，只补空缺」。', 'Replaced blueprints cannot be recovered. To fill gaps only, keep existing blueprints instead.')}
        confirmLabel={text('覆盖并生成', 'Overwrite and generate')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => settle(true)}
      />
      <InkDialog
        open={ask?.kind === 'warning'}
        onOpenChange={open => { if (!open) settle(false) }}
        title={text('架构还不完整', 'The architecture is incomplete')}
        description={<span className="stage-bp-prewrap">{ask?.kind === 'warning' ? ask.message : ''}</span>}
        footer={(
          <>
            <Button variant="secondary" onClick={() => settle(false)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={() => settle(true)}>{text('继续生成', 'Continue')}</Button>
          </>
        )}
      />
      <DangerConfirm
        open={ask?.kind === 'clear'}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text('清空全部故事规划？', 'Clear all blueprints?')}
        consequence={text(`将删除全部 ${count} 章故事规划。草稿与正文章节会保留。`, `The ${count} chapter ${pluralEn(count, 'blueprint')} will be deleted. Drafts and manuscript chapters remain.`)}
        recoverability={text('清空后无法恢复。想留底请先在设置的「项目备份」里导出存档。', 'This cannot be undone. Export an archive from Project backup in Settings first if you may need them.')}
        confirmLabel={text('清空全部', 'Clear all')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => void plan.clearAll()}
      />
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text(`删除第 ${deleting ?? ''} 章故事规划？`, `Delete the chapter ${deleting ?? ''} blueprint?`)}
        consequence={text('只删除这一章的故事规划，草稿与正文保留。', 'Only this chapter’s blueprint is deleted. Drafts and manuscript text remain.')}
        recoverability={text('删除后无法恢复。', 'This cannot be undone.')}
        confirmLabel={text('删除此章', 'Delete chapter')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { if (deleting !== null) void plan.deleteChapter(deleting) }}
      />
      <DangerConfirm
        open={ask?.kind === 'legacy'}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text('清除误导入正文？', 'Clear incorrectly imported text?')}
        consequence={text('将永久清除草稿、定稿、审稿和摘要等正文产物；角色、故事架构、故事规划与知识库会保留。只是缺下一章故事规划时，请取消并先补故事规划。',
          'Drafts, final manuscript text, reviews and summaries are permanently cleared. Characters, story architecture, story plans and the knowledge base are kept. If only the next blueprint is missing, cancel and add it first.')}
        recoverability={text('清除后无法恢复。', 'This cannot be undone.')}
        confirmLabel={text('清除误导入正文', 'Clear imported text')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => void plan.clearLegacyImportedText()}
      />
    </div>
  )
}
