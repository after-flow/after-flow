import { Link } from 'react-router-dom'
import type { Task } from '@/api/types'
import { Icon } from '@/components/ui/Icon'
import { TASK_STATUS_META, taskCategoryMeta } from '@/lib/labels'
import { formatDate } from '@/lib/format'

/**
 * 手続き1件の行。
 *
 * 左に種類のアイコン（どこへ行く手続きか）、右に残り日数を置き、
 * 一覧を目で走らせるだけで内容と急ぎ具合が掴めるようにする。
 */
export function TaskRow({ caseId, task }: { caseId: string; task: Task }) {
  const cat = taskCategoryMeta(task.category)
  const status = TASK_STATUS_META[task.status]
  const done = task.status === 'COMPLETED'
  const days = task.deadline?.daysRemaining

  const urgency =
    done || days == null
      ? null
      : days < 0
        ? { color: 'var(--color-state-red)', text: `${Math.abs(days)}日超過` }
        : days === 0
          ? { color: 'var(--color-state-red)', text: '今日まで' }
          : days <= 3
            ? { color: '#b57e12', text: `あと${days}日` }
            : { color: 'var(--color-ink-muted)', text: `あと${days}日` }

  return (
    <Link
      to={`/cases/${caseId}/tasks/${task.id}`}
      className={`row-card flex items-center gap-3 p-3.5 sm:gap-4 sm:p-4 ${done ? 'opacity-70' : ''}`}
    >
      {/* 種類を色と形で示す */}
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl sm:h-12 sm:w-12"
        style={
          done
            ? { background: 'var(--color-state-gray-soft)', color: 'var(--color-state-gray)' }
            : { background: cat.bg, color: cat.fg }
        }
        aria-hidden
      >
        <Icon name={done ? 'check' : cat.icon} size={24} strokeWidth={done ? 2.4 : 1.75} />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`block text-[1.02rem] font-bold leading-snug ${done ? 'line-through decoration-1' : ''}`}
        >
          {task.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-[var(--color-ink-faint)]">
          <span className={`badge ${status.className}`}>
            <Icon name={status.icon} size={13} />
            {status.label}
          </span>
          {task.submitTo && (
            <span className="hidden min-w-0 items-center gap-1 sm:inline-flex">
              <Icon name="pin" size={14} />
              <span className="truncate">{task.submitTo}</span>
            </span>
          )}
        </span>
      </span>

      {/* 残り日数を右端にそろえて、縦に目で追えるようにする */}
      <span className="w-[4.5rem] shrink-0 text-right sm:w-auto">
        {urgency ? (
          <>
            <span className="block font-bold leading-tight" style={{ color: urgency.color }}>
              {urgency.text}
            </span>
            <span className="hidden text-xs text-[var(--color-ink-faint)] sm:block">
              {task.deadline && formatDate(task.deadline.dueDate)}
            </span>
          </>
        ) : done ? (
          <span className="text-sm font-bold text-[var(--color-state-green)]">完了</span>
        ) : (
          <span className="text-sm text-[var(--color-ink-faint)]">期限なし</span>
        )}
      </span>

      <Icon name="chevron-right" size={18} className="shrink-0 text-[var(--color-ink-faint)]" />
    </Link>
  )
}
