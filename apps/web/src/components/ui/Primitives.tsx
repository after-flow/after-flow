import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useId } from 'react'
import { Icon } from './Icon'

/* ---------- Button ---------- */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  variant = 'secondary',
  size,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      {...props}
    />
  )
}

/* ---------- Card ---------- */

export function Card({
  title,
  action,
  children,
  className = '',
  bodyClassName = 'p-4 sm:p-5',
}: {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-5">
          <h2 className="section-title">{title}</h2>
          {action}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

/** 各画面の見出し。小見出し（eyebrow）＋タイトル＋説明＋右肩の操作で構成を揃える。 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-0.5 text-[1.55rem] font-bold">{title}</h1>
        {description && (
          <p className="mt-1 text-[var(--color-ink-muted)]">{description}</p>
        )}
      </div>
      {action}
    </header>
  )
}

/* ---------- 状態表示 ---------- */

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-[var(--color-ink-muted)]" role="status">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-brand)]" />
      <span>{label}…</span>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-critical" role="alert">
      <Icon name="warning" size={21} className="mt-0.5" />
      <div className="flex-1">
        <p className="font-bold">情報を表示できませんでした</p>
        <p className="mt-1">{message}</p>
        {onRetry && (
          <Button size="sm" className="mt-2" onClick={onRetry}>
            もう一度読み込む
          </Button>
        )}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-lg font-bold">{title}</p>
      {description && (
        <p className="max-w-md text-[var(--color-ink-muted)]">{description}</p>
      )}
      {action}
    </div>
  )
}

/* ---------- フォーム ---------- */

export function Field({
  label,
  required,
  hint,
  error,
  children,
  htmlFor,
  /** 入力フォームではなく操作用のコントロールに使う場合、必須／任意の表示を出さない */
  plain,
}: {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string
  children: ReactNode
  htmlFor?: string
  plain?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-bold" htmlFor={htmlFor}>
        {label}
        {plain ? null : required ? (
          <span className="ml-1.5 text-[var(--color-state-red)]">必須</span>
        ) : (
          <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">任意</span>
        )}
      </label>
      {hint && <p className="text-sm text-[var(--color-ink-muted)]">{hint}</p>}
      {children}
      {error && (
        <p
          className="flex items-center gap-1 text-sm font-bold text-[var(--color-state-red)]"
          role="alert"
        >
          <Icon name="warning" size={15} />
          {error}
        </p>
      )}
    </div>
  )
}

export function TextInput({
  label,
  required,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string
}) {
  const id = useId()
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      <input id={id} className="input" aria-invalid={error ? true : undefined} {...props} />
    </Field>
  )
}

export function SelectInput({
  label,
  required,
  hint,
  error,
  plain,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string
  plain?: boolean
}) {
  const id = useId()
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id} plain={plain}>
      <select id={id} className="select" aria-invalid={error ? true : undefined} {...props}>
        {children}
      </select>
    </Field>
  )
}

export function TextareaInput({
  label,
  required,
  hint,
  error,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string
}) {
  const id = useId()
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      <textarea id={id} className="textarea" aria-invalid={error ? true : undefined} {...props} />
    </Field>
  )
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-brand)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

/* ---------- 補助 ---------- */

export function SourceTag({ source }: { source: 'AI' | 'MANUAL' | 'RULE_ENGINE' }) {
  const meta = {
    AI: { label: 'AI検出', className: 'badge-blue' },
    MANUAL: { label: '手動登録', className: 'badge-gray' },
    RULE_ENGINE: { label: '自動生成', className: 'badge-gray' },
  }[source]
  return <span className={`badge ${meta.className}`}>{meta.label}</span>
}

export function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-[var(--color-line)] py-3 last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm font-bold text-[var(--color-ink-muted)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
