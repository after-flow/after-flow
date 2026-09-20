import { Link } from 'react-router-dom'
import type { Task } from '@aftercare/public-contracts'
import { Icon } from '@/components/ui/Icon'
import { taskCategoryMeta } from '@/lib/labels'
import { formatDate } from '@/lib/format'

/**
 * 「いま自分が何をすればよいか」に、読まずに答えるカード。
 *
 * 文章で説明するのではなく、
 *  - 残り日数を大きな数字と輪で
 *  - 行き先を色付きのアイコンで
 *  - 持ち物を並んだタグで
 * 示す。ここだけ見れば窓口に向かえる状態を目指す。
 */
export function NextActionCard({ caseId, task }: { caseId: string; task?: Task }) {
  if (!task) {
    return (
      <section className="card p-5 sm:p-6">
        <p className="eyebrow">次にやること</p>
        <p className="mt-1.5 text-lg font-bold">いま急いで進める手続きはありません</p>
        <p className="mt-1 text-[var(--color-ink-muted)]">
          落ち着いて、手続きの一覧から進められるものをご確認ください。
        </p>
        <Link className="btn btn-secondary mt-4" to={`/cases/${caseId}/tasks`}>
          手続きの一覧を見る
        </Link>
      </section>
    )
  }

  const cat = taskCategoryMeta(task.category)
  const days = task.deadline?.daysRemaining
  const tone =
    days == null
      ? 'neutral'
      : days < 0
        ? 'overdue'
        : days === 0
          ? 'today'
          : days <= 3
            ? 'soon'
            : 'normal'

  const accent = {
    overdue: 'var(--color-state-red)',
    today: 'var(--color-state-red)',
    soon: '#b57e12',
    normal: 'var(--color-brand)',
    neutral: 'var(--color-line-strong)',
  }[tone]

  /*
    輪は「使ってしまった時間」を表す。期限が近づくほど輪が埋まり、
    当日・超過で一周する。残りを描くと、急ぐときほど輪が空になって
    緊急さが伝わらなかったため、向きを逆にしている。
  */
  const total = task.deadline
    ? Math.max(
        1,
        Math.round(
          (new Date(`${task.deadline.dueDate}T00:00:00`).getTime() -
            new Date(`${task.deadline.startDate}T00:00:00`).getTime()) /
            86_400_000,
        ),
      )
    : 1
  const elapsedRatio = days == null ? 0 : Math.max(0, Math.min(1, 1 - days / total))
  const ringDeg = Math.round(elapsedRatio * 360)

  const bring = task.requiredDocuments?.filter((d) => !d.collected).slice(0, 4) ?? []

  return (
    <section
      className="card overflow-hidden"
      style={{ borderTop: `5px solid ${accent}` }}
      aria-label="次にやること"
    >
      <div className="p-5 sm:p-6">
        <p className="eyebrow">次にやること</p>

        <div className="mt-3 flex gap-4 sm:gap-5">
          {/* 残り日数：数字と輪で、読まずに分かるようにする */}
          <div className="shrink-0">
            <div
              className="relative grid h-[4.5rem] w-[4.5rem] place-items-center rounded-full sm:h-24 sm:w-24"
              style={{
                background: `conic-gradient(${accent} ${ringDeg}deg, var(--color-state-gray-soft) ${ringDeg}deg)`,
              }}
              role="img"
              aria-label={
                days == null
                  ? '期限の定めはありません'
                  : days < 0
                    ? `期限を${Math.abs(days)}日過ぎています`
                    : days === 0
                      ? '本日が期限です'
                      : `期限まであと${days}日`
              }
            >
              <div className="grid h-[3.6rem] w-[3.6rem] place-items-center rounded-full bg-[var(--color-surface)] sm:h-[4.9rem] sm:w-[4.9rem]">
                {days == null ? (
                  <span className="text-sm font-bold text-[var(--color-ink-faint)]">期限なし</span>
                ) : days < 0 ? (
                  <span className="text-center leading-tight" style={{ color: accent }}>
                    <span className="block text-xl font-bold sm:text-[1.6rem]">{Math.abs(days)}</span>
                    <span className="block text-xs font-bold">日超過</span>
                  </span>
                ) : days === 0 ? (
                  <span className="text-center text-sm font-bold leading-tight sm:text-base" style={{ color: accent }}>
                    本日
                    <br />
                    まで
                  </span>
                ) : (
                  <span className="text-center leading-tight">
                    <span className="block text-xs font-bold text-[var(--color-ink-faint)]">あと</span>
                    <span className="block text-2xl font-bold sm:text-[1.9rem]" style={{ color: accent }}>
                      {days}
                    </span>
                    <span className="block text-xs font-bold text-[var(--color-ink-faint)]">日</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {/*
              行き先を色と形で示す。
              画面が狭いときは見出しの幅を優先し、種類は提出先の横に小さく添える。
            */}
            <div className="flex items-start gap-3">
              <span
                className="hidden h-11 w-11 shrink-0 place-items-center rounded-xl sm:grid"
                style={{ background: cat.bg, color: cat.fg }}
                aria-hidden
              >
                <Icon name={cat.icon} size={22} />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold leading-snug sm:text-[1.4rem]">{task.title}</h2>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-ink-muted)]">
                  <span
                    className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-sm font-bold sm:hidden"
                    style={{ background: cat.bg, color: cat.fg }}
                  >
                    <Icon name={cat.icon} size={15} />
                    {cat.label}
                  </span>
                  {task.submitTo && (
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="pin" size={17} />
                      {task.submitTo}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {task.deadline && (
              <p className="mt-3 text-sm text-[var(--color-ink-muted)]">
                期限 {formatDate(task.deadline.dueDate)}（{task.deadline.basisLabel}）
              </p>
            )}

            {/* 持ち物をタグで並べる */}
            {bring.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--color-ink-muted)]">
                  <Icon name="bag" size={16} />
                  持っていくもの
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {bring.map((d) => (
                    <li
                      key={d.id}
                      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-2.5 py-1 text-sm"
                    >
                      {d.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Link className="btn btn-primary mt-4" to={`/cases/${caseId}/tasks/${task.id}`}>
              進め方を見る
              <Icon name="chevron-right" size={18} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
