/** ケースに入る前の画面（ログイン・同意・規約など）で使う枠 */
import type { ReactNode } from 'react'
import { Icon } from '@/kit/Icon'

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-rd-primary text-white">
        <Icon name="path" size={18} strokeWidth={2} />
      </span>
      <span className="text-[1.15rem] font-bold tracking-wide">after-flow</span>
    </span>
  )
}

/** wide: 一覧向け（max-w-xl）。doc: 読みものや同意の画面向け（max-w-2xl） */
export function Centered({ children, wide }: { children: ReactNode; wide?: boolean | 'doc' }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-rd-bg px-4 py-10 leading-normal text-rd-text">
      <div className={`w-full ${wide === 'doc' ? 'max-w-2xl' : wide ? 'max-w-xl' : 'max-w-md'}`}>{children}</div>
    </div>
  )
}

