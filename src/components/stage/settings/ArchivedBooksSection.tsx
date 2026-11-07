import { useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { ipc } from '../../../services/ipc-client'
import type { ProjectChannels } from '../../../shared/ipc-channels'
import { appErrorMessage, displayedErrorMessage } from '../../../i18n/app-errors'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { Notice } from '../../ui/Notice'
import { toast } from '../../ui/Toast'

type ArchivedBook = ProjectChannels['project:archived-list']['return'][number]

export default function ArchivedBooksSection() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [books, setBooks] = useState<ArchivedBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef(false)
  const [deleting, setDeleting] = useState<ArchivedBook | null>(null)

  useEffect(() => {
    let live = true
    void ipc.invoke('project:archived-list').then(list => {
      if (live) setBooks(list)
    }).catch(reason => {
      if (live) setError(appErrorMessage(useLocaleStore.getState().locale, reason))
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [attempt])

  const run = async (book: ArchivedBook, operation: 'restore' | 'delete') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(book.path)
    try {
      const result = operation === 'restore'
        ? await ipc.invoke('project:unarchive', book.path)
        : await ipc.invoke('project:archived-delete', book.path)
      if (!result.success) throw new Error(result.error)
      setBooks(current => current.filter(item => item.path !== book.path))
      toast.success(operation === 'restore'
        ? text(`已将「${book.name}」恢复到书架`, `Restored “${book.name}” to the shelf`)
        : text(`已删除「${book.name}」`, `Deleted “${book.name}”`))
      if ('warning' in result && typeof result.warning === 'string') toast.error(displayedErrorMessage(locale, result.warning))
      try { await useProjectStore.getState().loadRecentProjects() } catch (reason) {
        toast.error(text('操作已完成，但书架刷新失败。', 'The operation completed, but the shelf could not refresh.') + appErrorMessage(locale, reason))
      }
    } catch (reason) {
      toast.error(appErrorMessage(locale, reason))
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  return (
    <section aria-label={text('已归档的小说列表', 'Archived book list')} aria-busy={loading || busy !== null}>
      {loading ? <p role="status">{text('正在加载…', 'Loading…')}</p>
        : error ? <Notice tone="danger" title={text('无法加载已归档的小说', 'Could not load archived books')}>
          <p>{error}</p>
          <Button variant="secondary" onClick={() => { setLoading(true); setError(null); setAttempt(value => value + 1) }}>{text('重试', 'Retry')}</Button>
        </Notice>
          : books.length === 0 ? <div className="stage-archived-empty">
            <Archive size={28} aria-hidden="true" />
            <p>{text('暂无已归档的小说', 'No archived books yet')}</p>
            <p>{text('在小说菜单中选择「归档」，即可将小说收纳到这里。', 'Choose Archive from a book’s menu to keep it here.')}</p>
          </div>
            : <ul className="stage-archived-list">
              {books.map(book => <li key={book.path} className="stage-archived-book">
                <div className="stage-archived-details">
                  <h2>{book.name}</h2>
                  <p className="stage-archived-path">{book.path}</p>
                  <p>{text('归档于', 'Archived on')} {new Date(book.archivedAt).toLocaleDateString(locale)}</p>
                </div>
                <div className="stage-archived-actions">
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => { void run(book, 'restore') }}>
                    <ArchiveRestore size={14} aria-hidden="true" />{text('恢复', 'Restore')}
                  </Button>
                  <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setDeleting(book)}>
                    <Trash2 size={14} aria-hidden="true" />{text('删除', 'Delete')}
                  </Button>
                </div>
              </li>)}
            </ul>}
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={open => { if (!open) setDeleting(null) }}
        title={text(`删除《${deleting?.name ?? ''}》？`, `Delete “${deleting?.name ?? ''}”?`)}
        consequence={text('作品文件夹会连同全部章节、设定、知识库和版本历史一起删除。', 'The book folder is deleted along with every chapter, setting, knowledge entry and version.')}
        recoverability={text('删除后无法恢复。想继续保留这部小说，请取消或选择「恢复」。', 'This cannot be undone. Cancel or choose Restore to keep this book.')}
        typeToConfirm={{ expected: deleting?.name ?? '', label: text('输入作品名确认', 'Type the book title to confirm') }}
        cancelLabel={text('取消', 'Cancel')}
        confirmLabel={text('删除作品', 'Delete book')}
        onConfirm={() => { if (deleting) void run(deleting, 'delete') }}
      />
    </section>
  )
}
