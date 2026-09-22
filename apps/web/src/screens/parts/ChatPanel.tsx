import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CHAT_REPLY_POLL_TIMEOUT_MS, useAiCapabilities, useMessages, useSendMessage } from '@/lib/api/queries'
import { Icon } from '@/kit/Icon'
import { formatDateTime } from '@/lib/format'
import { Button, Loading, Notice, textareaClass } from '@/kit/kit'
import { AiConsentNotice, useAiConsent } from '@/kit/domain'
import { useChatDock } from '@/shell/chatDock'

const SUGGESTIONS = [
  'いま何を優先すればいいですか？',
  '死亡届はどこに出せばいいですか？',
  '相続放棄を考えています。何に気をつければいいですか？',
  '銀行口座はいつ止まりますか？',
]

/**
 * AIとの会話と入力欄。「AIに相談」の画面と、横に開く窓の両方で使う。
 * 入力欄は常に下に固定し、会話の部分だけをスクロールする。
 * 最初は「何を聞けばいいか分からない」ので、よくある質問をそのまま押せるようにする。
 *
 * compact：横の窓（幅が狭い）で使うときの詰めた表示
 */
export function ChatPanel({ caseId, base, compact }: { caseId: string; base: string; compact?: boolean }) {
  // 送信は 202 で受け付けられ、返答は後から履歴に現れる。受け付けられてから返答が来るまで（上限あり）だけ履歴を追いかける
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null)
  const { data, isLoading } = useMessages(caseId, { refetchInterval: awaitingSince ? 2_000 : false })
  const send = useSendMessage(caseId)
  const { input, setInput, pendingFocus, focusHandled } = useChatDock()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = data ?? []
  // 送信中（202を受け取るまで）と、受け付け後の返答待ち（ポーリング中）の両方を「送れない・返答待ち」として扱う
  const waitingForReply = awaitingSince !== null
  const pending = send.isPending || waitingForReply
  const consent = useAiConsent()
  const capabilities = useAiCapabilities()
  // 受付結果でも未接続が分かる。取得前に送った場合や、取得後に接続が切れた場合はこちらで拾う。
  const [replyUnavailable, setReplyUnavailable] = useState(false)
  // 取れていない間は塞がない。接続済みの環境で入口を消すより、送信後に理由を出す方を既定にする。
  const chatConnected = capabilities.data ? capabilities.data.features.ai_chat.available : true
  const showUnavailable = !chatConnected || replyUnavailable

  useEffect(() => {
    if (!awaitingSince) return
    const replied = messages.some((m) => m.role === 'assistant' && Date.parse(m.createdAt) >= awaitingSince)
    if (replied || Date.now() - awaitingSince > CHAT_REPLY_POLL_TIMEOUT_MS) setAwaitingSince(null)
  }, [messages, awaitingSince])

  // 会話の枠の中だけをスクロールする（scrollIntoView だと、横の窓を開いたときにページごと動いてしまう）
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending])

  // 書き出しを入れたら、続きをすぐ打てるよう末尾にカーソルを置く。
  // 入力欄は AI の利用に同意しているときだけ出るので、同意が確かめられてからも一度行う
  const showForm = consent.allowed
  useEffect(() => {
    const el = inputRef.current
    if (!showForm || !el || !pendingFocus) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    focusHandled()
  }, [pendingFocus, showForm, focusHandled])

  async function submit(text?: string, e?: FormEvent) {
    e?.preventDefault()
    const body = (text ?? input).trim()
    if (!body || pending || !consent.allowed) return
    // 例の質問を押したときは、書きかけ（手続きの画面からの書き出しを含む）を消さない
    if (text == null) setInput('')
    const accepted = await send.mutateAsync(body)
    // 受け付けられなかった発言も履歴には残る。黙って何も起きないように見せず、理由を出す。
    setReplyUnavailable(!accepted.runAccepted)
    if (accepted.runAccepted) setAwaitingSince(Date.now() - 1_000)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'px-4' : ''}`}>
        {isLoading && <Loading />}
        {!consent.allowed && !consent.loading && (
          <div className="py-4">
            <AiConsentNotice feature="AIへの相談" />
          </div>
        )}
        {!isLoading && consent.allowed && messages.length === 0 && (
          <div className={`flex flex-col items-center gap-4 text-center ${compact ? 'py-6' : 'py-10'}`}>
            <span className="grid h-12 w-12 place-items-center rounded-full bg-rd-primary-soft text-rd-primary-text">
              <Icon name="chat" size={24} />
            </span>
            <p className="text-[1rem] font-bold">分からないことを、そのまま聞いてください</p>
            <div className={`grid w-full max-w-lg gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={pending}
                  onClick={() => void submit(s)}
                  className="rounded-lg border border-rd-border bg-rd-card px-3 py-2.5 text-left text-[0.9rem] hover:border-rd-primary-line hover:bg-rd-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <ul className={`flex flex-col gap-4 pb-4 ${compact ? 'pt-4' : ''}`}>
          {messages.map((m) => {
            const mine = m.role === 'user'
            return (
              <li key={m.id} className={`flex animate-rise-in ${mine ? 'justify-end' : 'justify-start gap-2.5'}`}>
                {!mine && (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rd-primary text-white">
                    <Icon name="path" size={16} />
                  </span>
                )}
                <div
                  className={`${compact ? 'max-w-[90%]' : 'max-w-[85%]'} rounded-xl px-4 py-2.5 text-[0.97rem] leading-relaxed ${
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
        {pending && (
          // 送信中〜返答が届くまでの間、ずっと表示し続ける。ゆっくり明滅させて止まっていないことを伝える（読み込み中の印と同じ扱い）
          <p className="animate-pulse pb-4 text-[0.9rem] text-rd-text-2" aria-live="polite">
            {send.isPending ? '送信しています…' : '答えを考えています…'}
          </p>
        )}
        {consent.allowed && showUnavailable && !pending && (
          <div className="pb-4">
            <Notice tone="warning" role="status" title="いまはAIからの返信をお届けできません">
              {replyUnavailable
                ? 'お送りいただいた内容は記録しました。AIの返信機能が使える状態になってから、改めてご確認ください。'
                : 'AIの返信機能がまだ使える状態になっていません。お急ぎの場合は、手続きの画面の案内をご覧ください。'}
            </Notice>
          </div>
        )}
      </div>

      <form
        hidden={!consent.allowed}
        className={`shrink-0 border-t border-rd-border py-3 ${compact ? 'px-4' : ''}`}
        onSubmit={(e) => void submit(undefined, e)}
      >
        <div className="flex items-end gap-2 rounded-lg border border-rd-border bg-rd-card p-2 focus-within:border-rd-primary">
          <textarea
            ref={inputRef}
            aria-label="質問"
            className={`${textareaClass} min-h-11 flex-1 resize-none border-0 p-1.5 focus:border-0`}
            rows={2}
            // 窓は狭く、スマホでは Ctrl キーも無いので、送り方の説明は広い画面だけに出す
            placeholder={compact ? '質問を入力' : '質問を入力（Ctrl + Enter で送信）'}
            value={input}
            disabled={pending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
          <Button type="submit" variant="primary" disabled={!input.trim() || pending}>
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
