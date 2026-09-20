import type { ReactNode } from 'react'
import type { Person } from '@aftercare/public-contracts'
import { Icon } from '@/components/ui/Icon'
import { SPECIAL_CIRCUMSTANCE_META } from '@/lib/labels'

/** 「山田 花子」→「花」。名の頭文字を目印にする。 */
export function personInitial(name: string): string {
  const parts = name.trim().split(/[\s　]+/)
  const given = parts.length > 1 ? parts[parts.length - 1] : parts[0]
  return given.charAt(0) || '—'
}

export function PersonAvatar({
  person,
  size = 'md',
  tone,
}: {
  person: Person
  size?: 'sm' | 'md'
  /** 判断状況などで色を変えたいとき */
  tone?: { fg: string; bg: string }
}) {
  const palette = tone ?? {
    fg: person.isHeir ? 'var(--color-brand)' : 'var(--color-state-gray)',
    bg: person.isHeir ? 'var(--color-brand-soft)' : 'var(--color-state-gray-soft)',
  }
  const box = size === 'sm' ? 'h-9 w-9 text-base' : 'h-12 w-12 text-xl'

  return (
    <span
      className={`grid ${box} shrink-0 place-items-center rounded-full font-bold`}
      style={{ background: palette.bg, color: palette.fg }}
      aria-hidden
    >
      {personInitial(person.name)}
    </span>
  )
}

/** 関係者の1件。名前・続柄・特別な事情を1行で掴めるようにする。 */
export function PersonCard({
  person,
  actions,
  children,
}: {
  person: Person
  actions?: ReactNode
  children?: ReactNode
}) {
  const sc = person.specialCircumstance
    ? SPECIAL_CIRCUMSTANCE_META[person.specialCircumstance]
    : null

  return (
    <div className="card-quiet p-3.5 sm:p-4">
      <div className="flex items-start gap-3">
        <PersonAvatar person={person} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[1.05rem] font-bold">{person.name}</span>
            <span className="text-sm text-[var(--color-ink-muted)]">{person.relationship}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {person.isHeir && <span className="badge badge-blue">相続人</span>}
            {sc && (
              <span className="badge badge-yellow">
                <Icon name="warning" size={13} />
                {sc.label}
              </span>
            )}
          </div>

          {person.contact && (
            <p className="mt-1 text-sm text-[var(--color-ink-faint)]">連絡先：{person.contact}</p>
          )}
          {person.note && (
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{person.note}</p>
          )}

          {sc && (
            <p className="mt-2 flex gap-1.5 rounded-lg bg-[var(--color-state-yellow-soft)] p-2.5 text-sm text-[var(--color-state-yellow)]">
              <Icon name="warning" size={16} className="mt-1 shrink-0" />
              <span>{sc.hint}</span>
            </p>
          )}

          {children}
        </div>
      </div>

      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}
