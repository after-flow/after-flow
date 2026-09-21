/**
 * 画面の端に出す短いお知らせ。
 *
 * 保存や記録に失敗したとき、何も出さないと利用者は
 * 「押したのに反映されない」と何度も押すか、済んだと思い込んでしまう。
 * 失敗は必ずここで知らせる（QueryClient の MutationCache から呼ぶ）。
 */
import { useEffect, useState } from 'react'
import { Icon } from '@/kit/Icon'

type Toast = { id: number; tone: 'error' | 'success'; message: string }

let seq = 0
const listeners = new Set<(t: Toast) => void>()

export function toast(message: string, tone: Toast['tone'] = 'success') {
  const t = { id: ++seq, tone, message }
  listeners.forEach((l) => l(t))
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])

  useEffect(() => {
    const onToast = (t: Toast) => {
      setItems((prev) => [...prev.slice(-2), t])
      // 失敗は読み落とされないよう長めに残す
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.tone === 'error' ? 8000 : 4000)
    }
    listeners.add(onToast)
    return () => {
      listeners.delete(onToast)
    }
  }, [])

  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-4 lg:top-4 xl:top-auto xl:bottom-6"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-lg px-4 py-3 text-[0.94rem] leading-relaxed text-white shadow-lg ${
            t.tone === 'error' ? 'bg-rd-danger-text' : 'bg-rd-text'
          }`}
        >
          <Icon name={t.tone === 'error' ? 'alert' : 'check-circle'} size={19} className="mt-0.5 shrink-0" />
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            aria-label="閉じる"
            className="shrink-0 text-lg leading-none opacity-80 hover:opacity-100"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
