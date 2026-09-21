import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMessages, useSendMessage } from '@/lib/api/queries'
import type { MessageResource } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { formatDateTime } from '@/lib/format'
import { Button, Loading, textareaClass } from '@/kit/kit'
import { AiConsentNotice, useAiConsent, useCaseBase } from '@/kit/domain'

const SUGGESTIONS = [
  'いま何を優先すればいいですか？',
  '死亡届はどこに出せばいいですか？',
  '相続放棄を考えています。何に気をつければいいですか？',
  '銀行口座はいつ止まりますか？',
]

/**
 * AIに相談。
 * 画面いっぱいを会話に使い、入力欄は常に下に固定する。
 * 最初は「何を聞けばいいか分からない」ので、よくある質問をそのまま押せるようにする。
 */
export function ChatScreen() {
  const { caseId, base } = useCaseBase()
  const { data, isLoading } = useMessages(caseId)
  const send = useSendMessage(caseId)
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const messages = data ?? []
  const consent = useAiConsent()

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, send.isPending])

  async function submit(text?: string, e?: FormEvent) {
    e?.preventDefault()
    const body = (text ?? input).trim()
    if (!body || send.isPending || !consent.allowed) return
    setInput('')
    await send.mutateAsync(body)
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-3xl flex-col px-4 lg:h-dvh lg:px-8">
      <header className="shrink-0 py-5">
        <h1 className="text-[1.35rem] font-bold">AIに相談</h1>
        <p className="mt-0.5 text-[0.94rem] text-rd-text-2">いまの手続きの進み具合と期限をふまえて答えます。</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Loading />}
        {!consent.allowed && !consent.loading && (
          <div className="py-4">
            <AiConsentNotice feature="AIへの相談" />
          </div>
        )}
        {!isLoading && consent.allowed && messages.length === 0 && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-rd-primary-soft text-rd-primary-text">
              <Icon name="chat" size={24} />
            </span>
            <p className="text-[1rem] font-bold">分からないことを、そのまま聞いてください</p>
            <div className="grid w-full max-w-lg gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void submit(s)}
                  className="rounded-lg border border-rd-border bg-rd-card px-3 py-2.5 text-left text-[0.9rem] hover:border-rd-primary-line hover:bg-rd-primary-soft"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <ul className="flex flex-col gap-4 pb-4">
          {messages.map((m: MessageResource) => {
            const mine = m.role === 'user'
            return (
              <li key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start gap-2.5'}`}>
                {!mine && (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rd-primary text-white">
                    <Icon name="path" size={16} />
                  </span>
                )}
                <div
                  className={`max-w-[85%] rounded-xl px-4 py-2.5 text-[0.97rem] leading-relaxed ${
                    mine ? 'bg-rd-primary text-white' : 'border border-rd-border bg-rd-card'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {m.professionalNotice && (
                    <p className="mt-2 flex gap-1.5 border-t border-rd-border pt-2 text-[0.86rem] text-rd-warning-text">
                      <Icon name="warning" size={15} className="mt-0.5 shrink-0" />
                      この点は個別の法律・税務の判断が必要です。専門家にご相談ください。
                    </p>
                  )}
                  {m.escalationProposalId && (
                    <Link
                      to={`${base}/approvals`}
                      className="mt-2 inline-flex h-9 items-center rounded-md border border-rd-border px-3 text-[0.86rem] font-bold text-rd-text hover:bg-rd-shade"
                    >
                      専門家への相談について確かめる
                    </Link>
                  )}
                  <p className={`mt-1 text-[0.8rem] ${mine ? 'text-white/75' : 'text-rd-text-3'}`}>{formatDateTime(m.createdAt)}</p>
                </div>
              </li>
            )
          })}
        </ul>
        {send.isPending && (
          <p className="pb-4 text-[0.9rem] text-rd-text-2" aria-live="polite">
            答えを考えています…
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form hidden={!consent.allowed} className="shrink-0 border-t border-rd-border py-3" onSubmit={(e) => void submit(undefined, e)}>
        <div className="flex items-end gap-2 rounded-lg border border-rd-border bg-rd-card p-2 focus-within:border-rd-primary">
          <textarea
            aria-label="質問"
            className={`${textareaClass} min-h-11 flex-1 resize-none border-0 p-1.5 focus:border-0`}
            rows={2}
            placeholder="質問を入力（Ctrl + Enter で送信）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
          <Button type="submit" variant="primary" disabled={!input.trim() || send.isPending}>
            送る
          </Button>
        </div>
        <p className="mt-1.5 text-[0.8rem] text-rd-text-3">
          手続きのご案内と情報の整理のためのチャットです。書類の作成や、役所・金融機関への提出の代行は行いません。
        </p>
      </form>
    </div>
  )
}
