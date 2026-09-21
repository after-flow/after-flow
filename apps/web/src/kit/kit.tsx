/**
 * 画面の共通部品。
 *
 * 業務SaaS（バクラク等）の作法に寄せる。
 *  - 色は意味でだけ使う：操作=青 / 完了=緑 / 注意=黄 / 危険=赤 / それ以外=グレー
 *  - 1画面に「主ボタン（青）」は原則ひとつ。押すべきものを迷わせない
 *  - 影は使わず、面の区切りは線で作る
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon, type IconName } from '@/kit/Icon'

/* ---------- Button ---------- */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type ButtonSize = 'md' | 'sm' | 'lg'

const BTN_BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-bold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45'

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-rd-primary text-white hover:bg-rd-primary-text',
  secondary: 'border border-rd-border bg-rd-card text-rd-text hover:bg-rd-shade',
  danger: 'border border-rd-danger-line bg-rd-card text-rd-danger-text hover:bg-rd-danger-soft',
  ghost: 'text-rd-text-2 hover:bg-rd-shade hover:text-rd-text',
}

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-[0.9rem]',
  md: 'h-11 px-4 text-[0.97rem]',
  lg: 'h-12 px-6 text-[1.02rem]',
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md') {
  return `${BTN_BASE} ${BTN_VARIANT[variant]} ${BTN_SIZE[size]}`
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  ref?: React.Ref<HTMLButtonElement>
}) {
  return (
    <button type="button" className={`${buttonClass(variant, size)} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  )
}

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  icon,
  className = '',
  children,
}: {
  to: string
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  className?: string
  children: ReactNode
}) {
  return (
    <Link to={to} className={`${buttonClass(variant, size)} ${className}`}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </Link>
  )
}

/* ---------- Badge ---------- */

export type Tone = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'

const BADGE_TONE: Record<Tone, string> = {
  gray: 'bg-rd-shade text-rd-text-2',
  blue: 'bg-rd-primary-soft text-rd-primary-text',
  green: 'bg-rd-success-soft text-rd-success-text',
  yellow: 'bg-rd-warning-soft text-rd-warning-text',
  red: 'bg-rd-danger-soft text-rd-danger-text',
  purple: 'bg-[#f5f3ff] text-[#6d28d9]',
}

export function Badge({
  tone = 'gray',
  icon,
  children,
}: {
  tone?: Tone
  icon?: IconName
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[0.82rem] font-bold whitespace-nowrap ${BADGE_TONE[tone]}`}
    >
      {icon && <Icon name={icon} size={13} strokeWidth={2.2} />}
      {children}
    </span>
  )
}

/** 件数の丸。サイドバーやタブで使う */
export function CountPill({ n, tone = 'gray' }: { n: number; tone?: 'gray' | 'red' | 'blue' }) {
  const cls =
    tone === 'red'
      ? 'bg-rd-danger text-white'
      : tone === 'blue'
        ? 'bg-rd-primary text-white'
        : 'bg-rd-shade text-rd-text-2'
  return (
    <span
      className={`inline-block min-w-[22px] rounded-full px-1.5 text-center text-[0.8rem] font-bold leading-[22px] ${cls}`}
    >
      {n}
    </span>
  )
}

/* ---------- Page ---------- */

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className={`mx-auto flex w-full flex-col gap-5 px-4 py-6 lg:px-8 ${narrow ? 'max-w-4xl' : 'max-w-6xl'}`}>
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  badges,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  back?: { to: string; label: string }
  badges?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Link
          to={back.to}
          className="inline-flex w-fit items-center gap-0.5 text-[0.9rem] font-bold text-rd-text-2 hover:text-rd-text"
        >
          <Icon name="chevron-left" size={15} />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[1.35rem] font-bold leading-snug">{title}</h1>
            {badges}
          </div>
          {description && (
            <p className="mt-1 text-[0.94rem] leading-relaxed text-rd-text-2">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export function Panel({
  title,
  action,
  children,
  className = '',
  padded = true,
}: {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section className={`rounded-lg border border-rd-border bg-rd-card ${className}`}>
      {(title || action) && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-rd-border px-4 py-2">
          {title && <h2 className="text-[1rem] font-bold">{title}</h2>}
          {action}
        </div>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: T; label: string; count?: number; countTone?: 'gray' | 'red' | 'blue' }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-x-1 border-b border-rd-border">
      {items.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[0.94rem] font-bold ${
              active
                ? 'border-rd-primary text-rd-primary-text'
                : 'border-transparent text-rd-text-2 hover:text-rd-text'
            }`}
          >
            {t.label}
            {t.count != null && <CountPill n={t.count} tone={active ? (t.countTone ?? 'blue') : 'gray'} />}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Notice ---------- */

const NOTICE_TONE = {
  info: { box: 'border-rd-primary-line bg-rd-primary-soft', fg: 'text-rd-primary-text', icon: 'info' },
  warning: { box: 'border-rd-warning-line bg-rd-warning-soft', fg: 'text-rd-warning-text', icon: 'warning' },
  danger: { box: 'border-rd-danger-line bg-rd-danger-soft', fg: 'text-rd-danger-text', icon: 'warning' },
  success: { box: 'border-[#a7f3d0] bg-rd-success-soft', fg: 'text-rd-success-text', icon: 'check-circle' },
} as const

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: keyof typeof NOTICE_TONE
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  role?: 'alert' | 'status'
}) {
  const t = NOTICE_TONE[tone]
  return (
    <div role={role} className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3 ${t.box}`}>
      <Icon name={t.icon} size={18} className={`mt-0.5 shrink-0 ${t.fg}`} />
      <div className="min-w-0 flex-1 text-[0.94rem] leading-relaxed">
        {title && <p className={`font-bold ${t.fg}`}>{title}</p>}
        {children && <div className={title ? 'mt-0.5 text-rd-text' : 'text-rd-text'}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

/* ---------- States ---------- */

export function Loading({ label = '読み込み中' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-[0.94rem] text-rd-text-2">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-rd-border border-t-rd-primary" />
      {label}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon name="alert" size={28} className="text-rd-danger-text" />
      <p className="text-[0.97rem]">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          もう一度読み込む
        </Button>
      )}
    </div>
  )
}

export function Empty({
  icon = 'check-circle',
  title,
  children,
}: {
  icon?: IconName
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-rd-shade text-rd-text-3">
        <Icon name={icon} size={22} />
      </span>
      <p className="text-[1rem] font-bold">{title}</p>
      {children && <div className="text-[0.9rem] leading-relaxed text-rd-text-2">{children}</div>}
    </div>
  )
}

/* ---------- Definition list ---------- */

export function DList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[7.5rem_1fr] gap-x-4 text-[0.94rem]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="border-b border-rd-border-2 py-2.5 text-rd-text-2">{r.label}</dt>
          <dd className="m-0 min-w-0 border-b border-rd-border-2 py-2.5 break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ---------- Form ---------- */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center gap-1.5 text-[0.9rem] font-bold">
        {label}
        {required ? (
          <span className="rounded bg-rd-danger-soft px-1 text-[0.8rem] text-rd-danger-text">必須</span>
        ) : (
          <span className="text-[0.8rem] font-normal text-rd-text-3">任意</span>
        )}
      </label>
      {children(id)}
      {hint && !error && <p className="text-[0.84rem] text-rd-text-2">{hint}</p>}
      {error && <p className="text-[0.84rem] font-bold text-rd-danger-text">{error}</p>}
    </div>
  )
}

export const inputClass =
  'h-11 w-full rounded-md border border-rd-border bg-rd-card px-3 text-[0.97rem] text-rd-text placeholder:text-rd-text-3 hover:border-rd-text-3 focus:border-rd-primary focus:outline-none aria-[invalid=true]:border-rd-danger'

export const textareaClass =
  'min-h-24 w-full rounded-md border border-rd-border bg-rd-card px-3 py-2 text-[0.97rem] leading-relaxed text-rd-text placeholder:text-rd-text-3 hover:border-rd-text-3 focus:border-rd-primary focus:outline-none'

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[0.94rem] leading-relaxed">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-rd-primary"
      />
      <span>{children}</span>
    </label>
  )
}

/* ---------- Modal ---------- */

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 呼び出し側は onClose を毎回作り直すことが多い。依存に入れると再描画のたびに
  // 下のフォーカス移動が走り、入力中の欄からカーソルが外れてしまうため、参照で持つ
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    // 開いたときに一度だけ、ダイアログへフォーカスを移す
    ref.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-xl bg-rd-card sm:rounded-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-rd-border px-5 py-3.5">
          <div>
            <h2 className="text-[1rem] font-bold">{title}</h2>
            {description && (
              <div className="mt-1 text-[0.9rem] leading-relaxed text-rd-text-2">{description}</div>
            )}
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-rd-text-2 hover:bg-rd-shade"
          >
            <span aria-hidden className="text-lg leading-none">×</span>
          </button>
        </div>
        {children && <div className="overflow-y-auto px-5 py-4">{children}</div>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-rd-border bg-rd-bg px-5 py-3">
          {footer ?? <Button onClick={onClose}>閉じる</Button>}
        </div>
      </div>
    </div>
  )
}

export function Confirm({
  open,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  disabled,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  description?: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  disabled?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy || disabled} onClick={onConfirm}>
            {busy ? '処理中…' : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
