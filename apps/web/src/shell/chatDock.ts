import { createContext, useContext } from 'react'

/**
 * 「AIに相談」を、画面を移らずに横（スマホでは下）に開くための窓口。
 *
 * 会話は手続きの画面を見ながら使いたいので、専用の画面へ移すのではなく、画面の枠（AppShell）が持つ。
 * 書きかけの質問も枠が持ち、横の窓と「AIに相談」の画面のどちらで開いても同じ文が続く。
 */
export interface ChatDock {
  isOpen: boolean
  /** 開く。draft を渡すと、入力欄が空（または前の書き出しのまま）のときに書き出しとして入れる */
  open: (draft?: string) => void
  close: () => void
  input: string
  setInput: (value: string) => void
  /** 書き出しを入れた直後だけ true。入力欄はこれを見てカーソルを末尾に置き、focusHandled を呼ぶ */
  pendingFocus: boolean
  focusHandled: () => void
}

export const ChatDockContext = createContext<ChatDock | null>(null)

export function useChatDock(): ChatDock {
  const dock = useContext(ChatDockContext)
  if (!dock) throw new Error('useChatDock は AppShell の中で使う')
  return dock
}
