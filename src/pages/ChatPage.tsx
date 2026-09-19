import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMessages, useSendMessage } from '@/api/queries'
import { Button, PageHeader, Spinner } from '@/components/ui/Primitives'
import { formatDateTime } from '@/lib/format'
import { Icon } from '@/components/ui/Icon'

const SUGGESTIONS = [
  'いま何を優先すればいいですか？',
  '死亡届はどこに出せばいいですか？',
  '相続放棄を考えていますが、何に気をつければいいですか？',
]

export function ChatPage() {
  const { caseId = '' } = useParams()
  const { data, isLoading } = useMessages(caseId)
  const send = useSendMessage(caseId)
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const messages = data?.items ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, send.isPending])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const body = input.trim()
    if (!body || send.isPending) return
    setInput('')
    await send.mutateAsync(body)
  }

  return (
    <div className="flex h-[calc(100dvh-10rem)] flex-col gap-3 lg:h-[calc(100dvh-7rem)]">
      <PageHeader
        eyebrow="AI相談"
        title="AIに相談する"
        description="このケースの進み具合や期限をふまえてお答えします。"
      />

      <div className="card min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading && <Spinner />}

        {!isLoading && messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-[var(--color-ink-muted)]">
              わからないことをお気軽にご質問ください。たとえば：
            </p>
            <div className="flex flex-col items-start gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} size="sm" onClick={() => setInput(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}

        <ul className="flex flex-col gap-4">
          {messages.map((m) => (
            <li
              key={m.id}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  m.role === 'user'
                    ? 'bg-[var(--color-brand)] text-white'
                    : 'bg-[var(--color-surface-sunken)]'
                }`}
              >
                <p className="whitespace-pre-wrap">{m.body}</p>

                {m.professionalNotice && (
                  <p className="mt-2 flex gap-1.5 border-t border-[var(--color-line)] pt-2 text-sm text-[var(--color-state-yellow)]">
                    <Icon name="warning" size={16} className="mt-1" />
                    <span>
                      この点は個別の法律・税務判断が必要です。専門家への相談をおすすめします。
                    </span>
                  </p>
                )}

                {m.escalationApprovalId && (
                  <Link
                    className="btn btn-secondary btn-sm mt-2"
                    to={`/cases/${caseId}/approvals/${m.escalationApprovalId}`}
                  >
                    専門家に相談する
                  </Link>
                )}

                <p
                  className={`mt-1 text-xs ${
                    m.role === 'user' ? 'text-white/80' : 'text-[var(--color-ink-faint)]'
                  }`}
                >
                  {formatDateTime(m.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {send.isPending && (
          <p className="mt-3 text-[var(--color-ink-muted)]" aria-live="polite">
            回答を作成しています…
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form className="flex gap-2" onSubmit={(e) => void submit(e)}>
        <label className="visually-hidden" htmlFor="chat-input">
          質問を入力
        </label>
        <textarea
          id="chat-input"
          className="textarea min-h-[3rem] flex-1"
          rows={2}
          placeholder="質問を入力してください"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
        />
        <Button type="submit" variant="primary" disabled={!input.trim() || send.isPending}>
          質問する
        </Button>
      </form>

      {/* 常設フッター（仕様書セクション8） */}
      <p className="text-sm text-[var(--color-ink-muted)]">
        このチャットは手続きのご案内と情報の整理を目的としています。書類の作成や、役所・金融機関への提出・送信の代行は行いません。
      </p>
    </div>
  )
}
