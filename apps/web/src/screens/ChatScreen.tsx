import { useCaseBase } from '@/kit/domain'
import { ChatPanel } from './parts/ChatPanel'

/**
 * AIに相談（画面いっぱいで使うとき）。
 * ふだんはどの画面からでも横（スマホでは下）に開く窓で使う。会話と書きかけの質問は窓と共通。
 */
export function ChatScreen() {
  const { caseId, base } = useCaseBase()

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-3xl flex-col px-4 lg:h-dvh lg:px-8">
      <header className="shrink-0 py-5">
        <h1 className="text-[1.35rem] font-bold">AIに相談</h1>
        <p className="mt-0.5 text-[0.94rem] text-rd-text-2">いまの手続きの進み具合と期限をふまえて答えます。</p>
      </header>
      <ChatPanel caseId={caseId} base={base} />
    </div>
  )
}
