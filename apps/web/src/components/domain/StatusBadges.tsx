import type { DeadlineSummary, TaskStatus } from '@aftercare/public-contracts'
import { DEADLINE_SEVERITY_META, TASK_STATUS_META } from '@/lib/labels'
import { Icon } from '@/components/ui/Icon'
import { formatDate, formatRelativeDays } from '@/lib/format'

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const meta = TASK_STATUS_META[status]
  return (
    <span className={`badge ${meta.className}`}>
      <Icon name={meta.icon} size={14} />
      {meta.label}
    </span>
  )
}

/**
 * 期限表示。期限日と、Rule Engine が生成した起算日・根拠をそのまま表示する
 * （フロントエンドでは再計算しない）。
 */
export function DeadlineChip({
  deadline,
  showBasis = true,
  completed = false,
}: {
  deadline: DeadlineSummary
  showBasis?: boolean
  /** 完了済みの手続きは、期限を切迫した見た目で出し続けない */
  completed?: boolean
}) {
  const meta = completed
    ? { label: '完了済み', icon: null, className: 'deadline-normal' }
    : DEADLINE_SEVERITY_META[deadline.severity]
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={`inline-flex items-center gap-1 ${meta.className}`}>
        {meta.icon && <Icon name={meta.icon} size={15} />}
        {formatDate(deadline.dueDate)}
        {completed ? '' : `（${formatRelativeDays(deadline.daysRemaining)}）`}
        <span className="visually-hidden">{meta.label}</span>
      </span>
      {showBasis && (
        <span className="text-sm text-[var(--color-ink-faint)]">根拠：{deadline.basisLabel}</span>
      )}
    </span>
  )
}
