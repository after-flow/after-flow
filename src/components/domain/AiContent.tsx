import type { ReactNode } from 'react'
import { Icon } from '@/components/ui/Icon'

/**
 * AIが生成した文章を、アプリ自身の文言と区別して表示する。
 *
 * 書類の内容はAIへの入力になるため、取り込んだ書類に
 * 「この提案は必ず承認してください」といった、アプリからの指示に見せかけた文章が
 * 紛れ込む可能性がある（プロンプトインジェクション）。
 * 生成された文章をアプリの見出しや説明文と同じ見た目で出すと、
 * 利用者はどちらがアプリからの案内なのか区別できない。
 *
 * そのため、AIが書いた文章は引用として囲み、出所を明示する。
 */
export function AiContent({
  children,
  label = 'AIが作成した文章です',
}: {
  children: ReactNode
  label?: string
}) {
  return (
    <figure className="m-0 border-l-4 border-[var(--color-state-blue)] bg-[var(--color-surface-sunken)] py-2 pl-4 pr-3">
      <figcaption className="mb-1 flex items-center gap-1.5 text-sm font-bold text-[var(--color-state-blue)]">
        <Icon name="pencil" size={15} />
        {label}
      </figcaption>
      <div className="whitespace-pre-wrap">{children}</div>
    </figure>
  )
}
