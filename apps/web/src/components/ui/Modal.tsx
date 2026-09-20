import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Primitives'

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--color-surface)] p-5 sm:rounded-2xl"
      >
        <h2 className="text-lg font-bold">{title}</h2>
        {description && <div className="mt-2 text-[var(--color-ink-muted)]">{description}</div>}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {footer ?? <Button onClick={onClose}>閉じる</Button>}
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = 'primary',
  onConfirm,
  onClose,
  disabled,
  children,
}: {
  open: boolean
  title: string
  description?: ReactNode
  confirmLabel: string
  confirmVariant?: 'primary' | 'danger'
  onConfirm: () => void
  onClose: () => void
  disabled?: boolean
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
          <Button onClick={onClose}>キャンセル</Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={disabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
