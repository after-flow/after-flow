import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/components/ui/Icon'

/**
 * 財産・債務・契約・給付の1行。
 *
 * タスク一覧と同じ作りにそろえ、左のアイコンで種類が、
 * 右の値で金額や状態が、目で追えるようにする。
 */
export function ItemRow({
  icon,
  iconFg,
  iconBg,
  title,
  badges,
  sub,
  value,
  children,
  muted = false,
}: {
  icon: IconName
  iconFg: string
  iconBg: string
  title: string
  badges?: ReactNode
  sub?: ReactNode
  /** 右端に大きく出す値（金額など） */
  value?: ReactNode
  children?: ReactNode
  muted?: boolean
}) {
  return (
    <div className={`card-quiet p-3.5 sm:p-4 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl sm:h-11 sm:w-11"
          style={{ background: iconBg, color: iconFg }}
          aria-hidden
        >
          <Icon name={icon} size={22} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[1.03rem] font-bold leading-snug">{title}</span>
            {value && <span className="shrink-0 font-bold tabular-nums">{value}</span>}
          </div>
          {badges && <div className="mt-1 flex flex-wrap items-center gap-1.5">{badges}</div>}
          {sub && <div className="mt-1 text-sm text-[var(--color-ink-muted)]">{sub}</div>}
        </div>
      </div>

      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

/** 財産・債務・契約の種別ごとの色と形 */
export const ITEM_ICONS: Record<string, { icon: IconName; fg: string; bg: string }> = {
  // 財産
  BANK: { icon: 'bank', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  REAL_ESTATE: { icon: 'home', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  SECURITIES: { icon: 'calculator', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  CRYPTO: { icon: 'bank', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  VEHICLE: { icon: 'bag', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  // 債務
  LOAN: { icon: 'bank', fg: 'var(--color-state-red)', bg: 'var(--color-state-red-soft)' },
  CREDIT: { icon: 'wallet', fg: 'var(--color-state-red)', bg: 'var(--color-state-red-soft)' },
  TAX: { icon: 'calculator', fg: 'var(--color-state-red)', bg: 'var(--color-state-red-soft)' },
  GUARANTEE: { icon: 'scroll', fg: 'var(--color-state-red)', bg: 'var(--color-state-red-soft)' },
  // 契約
  UTILITY: { icon: 'plug', fg: 'var(--color-state-yellow)', bg: 'var(--color-state-yellow-soft)' },
  TELECOM: { icon: 'chat', fg: 'var(--color-state-yellow)', bg: 'var(--color-state-yellow-soft)' },
  SUBSCRIPTION: { icon: 'plug', fg: 'var(--color-state-yellow)', bg: 'var(--color-state-yellow-soft)' },
  INSURANCE: { icon: 'shield', fg: 'var(--color-state-blue)', bg: 'var(--color-state-blue-soft)' },
  PENSION: { icon: 'shield', fg: 'var(--color-state-blue)', bg: 'var(--color-state-blue-soft)' },
  // 給付
  INSURANCE_PAYOUT: { icon: 'shield', fg: 'var(--color-state-blue)', bg: 'var(--color-state-blue-soft)' },
  LUMP_SUM: { icon: 'wallet', fg: 'var(--color-state-blue)', bg: 'var(--color-state-blue-soft)' },
  OTHER: { icon: 'checklist', fg: 'var(--color-state-gray)', bg: 'var(--color-state-gray-soft)' },
}

export function itemIcon(kind: string) {
  return ITEM_ICONS[kind] ?? ITEM_ICONS.OTHER
}
