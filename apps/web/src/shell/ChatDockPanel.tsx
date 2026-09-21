import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@/kit/Icon'
import { ChatPanel } from '@/screens/parts/ChatPanel'
import { useChatDock } from './chatDock'

/** 横に固定したときの幅（sm:w-96 と同じ）。本文の下に固定したボタン（手続きの画面）も、この幅だけ右を空ける */
export const CHAT_DOCK_WIDTH = '24rem'

/**
 * 横（スマホでは下）に開く「AIに相談」の窓。
 *
 *  広い画面（xl〜）：右に固定し、本文はその分だけ狭くなる。手続きの画面と並べて見られる。
 *  中くらいの画面：右から重ねて出す。背景は暗くせず、左側の画面はそのまま操作できる。
 *  スマホ：下から出す。上に本文が見え、本文はスクロールして読める。
 *
 * 画面を移っても閉じない（案内を見比べながら相談を続けられるように）。
 */
export function ChatDockPanel({ caseId, base }: { caseId: string; base: string }) {
  const dock = useChatDock()
  const ref = useRef<HTMLElement>(null)

  // 書き出しなしで開いたときは、窓へフォーカスを移す（入力欄に移すと、スマホではキーボードで会話が隠れる）
  const withDraft = useRef(dock.pendingFocus)
  useEffect(() => {
    if (!withDraft.current) ref.current?.focus()
  }, [])

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="AIに相談"
      onKeyDown={(e) => {
        // 日本語の変換を Esc で取り消したときは閉じない（変換中の文字ごと窓が閉じてしまう）
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) dock.close()
      }}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[65dvh] animate-sheet-up flex-col rounded-t-xl border-t border-rd-border bg-rd-bg shadow-[0_-8px_24px_rgb(0_0_0/0.12)] outline-none sm:inset-x-auto sm:top-0 sm:right-0 sm:h-dvh sm:w-96 sm:rounded-none sm:border-t-0 sm:border-l sm:shadow-xl xl:sticky xl:bottom-auto xl:shrink-0 xl:shadow-none sm:animate-dock-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-rd-border bg-rd-card px-3 sm:px-4">
        <Icon name="chat" size={18} className="text-rd-primary-text" />
        <h2 className="min-w-0 flex-1 truncate text-[1rem] font-bold">AIに相談</h2>
        <Link
          to={`${base}/chat`}
          onClick={dock.close}
          className="flex h-9 items-center rounded-md px-2.5 text-[0.86rem] font-bold text-rd-text-2 hover:bg-rd-shade hover:text-rd-text"
        >
          大きく開く
        </Link>
        <button
          type="button"
          aria-label="閉じる"
          onClick={dock.close}
          className="grid h-9 w-9 place-items-center rounded-md text-rd-text-2 hover:bg-rd-shade"
        >
          <span aria-hidden className="text-xl leading-none">×</span>
        </button>
      </header>
      <ChatPanel caseId={caseId} base={base} compact />
    </aside>
  )
}
