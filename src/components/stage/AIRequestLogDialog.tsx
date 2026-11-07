import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import type { AIRequestRecord, AIRequestSummary } from '../../shared/ai-request-log'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/Dialog'
import './styles/ai-request-log.css'

function RequestLogContent() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [records, setRecords] = useState<AIRequestSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AIRequestRecord | null>(null)
  const detailRef = useRef<AIRequestRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await ipc.invoke('llm:request-log-list')
        if (disposed) return
        setRecords(next)
        const selected = next.find(record => record.id === selectedId)
        if (selectedId && !selected) {
          setSelectedId(null)
          setDetail(null)
          detailRef.current = null
        } else if (selected && (detailRef.current?.id !== selected.id || detailRef.current.revision !== selected.revision)) {
          const record = await ipc.invoke('llm:request-log-detail', selected.id)
          if (disposed) return
          detailRef.current = record
          setDetail(record)
        }
        setError(false)
      } catch {
        if (!disposed) setError(true)
      } finally {
        if (!disposed) {
          setLoading(false)
          timer = setTimeout(() => void refresh(), 500)
        }
      }
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [selectedId])

  const statusLabel = (status: AIRequestSummary['status']) => ({
    running: text('生成中', 'Generating'), succeeded: text('已完成', 'Completed'),
    incomplete: text('未完整结束', 'Incomplete'), cancelled: text('已取消', 'Cancelled'), failed: text('失败', 'Failed'),
  })[status]
  const token = (value: number | null | undefined) => value == null ? text('未提供', 'Not reported') : value.toLocaleString(locale)
  const selected = records.find(record => record.id === selectedId)
  const current = detail?.id === selectedId ? detail : null

  return <>
    <DialogHeader>
      <DialogTitle>{text('AI 记录', 'AI request log')}</DialogTitle>
      <DialogDescription>{text('本次应用会话最近 50 条请求（跨作品），重启后清空。生成中的回答会实时更新。',
        'The latest 50 requests across books in this app session. Cleared on restart. Responses update live.')}</DialogDescription>
    </DialogHeader>
    {error && <p className="ai-log-error" role="alert">{text('读取记录失败，正在重试…', 'Unable to load records. Retrying…')}</p>}
    <div className="ai-log-layout">
      <div className="ai-log-list" aria-label={text('最近请求', 'Recent requests')}>
        {loading && <p role="status">{text('加载中…', 'Loading…')}</p>}
        {!loading && !error && records.length === 0 && <p>{text('暂无 AI 请求记录。发起一次 AI 生成后，可在此查看提示词与回答。', 'No AI requests yet. Generate with AI to inspect prompts and responses here.')}</p>}
        {records.map(record => <button type="button" key={record.id} className="ai-log-row"
          aria-pressed={record.id === selectedId} onClick={() => setSelectedId(record.id)}>
          <span className="ai-log-row-heading"><strong>{record.modelName}</strong><span data-status={record.status}>{statusLabel(record.status)}</span></span>
          <time dateTime={new Date(record.startedAt).toISOString()}>{new Date(record.startedAt).toLocaleString(locale, { hour12: false })}</time>
          <span>{(record.durationMs / 1000).toFixed(1)} s · {text('总 Token', 'Total tokens')}: {token(record.usage?.totalTokens)}</span>
        </button>)}
      </div>
      <div className="ai-log-detail" aria-label={text('请求详情', 'Request details')}>
        {!selected && <p className="ai-log-placeholder">{text('选择一条记录，查看提示词与回答。', 'Select a request to inspect its prompts and response.')}</p>}
        {selected && !current && <p role="status">{text('加载详情中…', 'Loading details…')}</p>}
        {selected && current && <>
          <h3>{current.modelName}</h3>
          <dl className="ai-log-metadata">
            <div><dt>{text('模型', 'Model')}</dt><dd>{current.modelId} · {current.protocol}</dd></div>
            <div><dt>{text('状态', 'Status')}</dt><dd>{statusLabel(selected.status)}{current.finishReason ? ` · ${current.finishReason}` : ''}</dd></div>
            <div><dt>{text('请求时间', 'Started')}</dt><dd>{new Date(current.startedAt).toLocaleString(locale, { hour12: false })}</dd></div>
            <div><dt>{text('耗时', 'Duration')}</dt><dd>{(selected.durationMs / 1000).toFixed(1)} s · {current.streaming ? text('流式', 'Streaming') : text('非流式', 'Non-streaming')}</dd></div>
            <div><dt>{text('输入 / 输出 / 总 Token', 'Input / output / total tokens')}</dt><dd>{token(current.usage?.promptTokens)} / {token(current.usage?.completionTokens)} / {token(current.usage?.totalTokens)}</dd></div>
            <div><dt>Temperature / Max tokens</dt><dd>{current.parameters.temperature ?? text('默认', 'Default')} / {current.parameters.maxTokens}</dd></div>
            {current.parameters.responseFormat && <div><dt>{text('响应格式', 'Response format')}</dt><dd>{current.parameters.responseFormat.type}</dd></div>}
          </dl>
          {current.error && <section className="ai-log-error"><h4>{text('错误信息', 'Error')}</h4><pre>{current.error}</pre></section>}
          {current.messages.map((message, index) => <section key={index} className="ai-log-message">
            <h4>{message.role === 'system' ? 'System prompt' : message.role === 'user' ? 'User prompt' : message.role} <span>#{index + 1}</span></h4>
            <pre>{message.content || text('（空）', '(empty)')}</pre>
          </section>)}
          <section className="ai-log-message" aria-label={text('回答', 'Response')}>
            <h4>{text('回答', 'Response')}{selected.status === 'running' && <span role="status"> · {text('实时更新中…', 'Updating live…')}</span>}</h4>
            <pre>{current.response || (selected.status === 'running' ? text('等待模型返回…', 'Waiting for the model…') : text('（无回答内容）', '(no response content)'))}</pre>
          </section>
        </>}
      </div>
    </div>
  </>
}

export default function AIRequestLogDialog() {
  const text = useLocaleStore(s => s.text)
  const [open, setOpen] = useState(false)
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button variant="text" size="sm"><History size={14} aria-hidden="true" />{text('AI 记录', 'AI log')}</Button>
    </DialogTrigger>
    <DialogContent className="ai-log-dialog">
      {open && <RequestLogContent />}
    </DialogContent>
  </Dialog>
}
