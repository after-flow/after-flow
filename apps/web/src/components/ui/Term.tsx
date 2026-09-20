import { useId, useState } from 'react'
import { GLOSSARY } from '@/lib/terms'

/**
 * 専門用語に平易な言い換えを併記する（仕様書セクション11）。
 * ホバーだけでなくフォーカス・タップでも開くようにする。
 */
export function Term({ word }: { word: keyof typeof GLOSSARY | string }) {
  const entry = GLOSSARY[word]
  const [open, setOpen] = useState(false)
  const id = useId()

  if (!entry) return <>{word}</>

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="term bg-transparent p-0 text-inherit"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {word}
        <span className="visually-hidden">（用語の説明を開く）</span>
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1.5 block w-72 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-sm font-normal leading-relaxed shadow-lg"
        >
          <span className="block font-bold">{entry.plain}</span>
          <span className="mt-1 block text-[var(--color-ink-muted)]">{entry.detail}</span>
        </span>
      )}
    </span>
  )
}
