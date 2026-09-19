import type { InheritanceDecisionSummary } from '@/api/types'
import { Icon } from '@/components/ui/Icon'
import { Term } from '@/components/ui/Term'
import { formatDate, daysUntil } from '@/lib/format'

/**
 * 相続方法の判断がどこまで進んでいるか。
 *
 * 放棄前ロックは「相続人全員の判断が揃うまで」解けるものではなく、
 * 全員が揃ってはじめて解ける。その条件が文章だと伝わらないので、
 * 人数の進み具合として見せる。
 */
export function DecisionProgress({ decision }: { decision: InheritanceDecisionSummary }) {
  const total = decision.perHeir.length
  const decided = decision.perHeir.filter((h) => h.method != null).length
  const remaining = total - decided

  const daysLeft = daysUntil(decision.deliberationDeadline)

  const done = total > 0 && remaining === 0

  return (
    <section
      className="card p-4 sm:p-5"
      style={{
        borderLeft: `5px solid ${done ? 'var(--color-state-green)' : 'var(--color-state-yellow)'}`,
      }}
      aria-label="相続方法の判断の進み具合"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* 人数ぶんの点で進み具合を示す */}
        <div className="flex items-center gap-1.5" role="img" aria-label={`${total}人中${decided}人が判断済み`}>
          {decision.perHeir.map((h) => (
            <span
              key={h.personId}
              className="grid h-7 w-7 place-items-center rounded-full border-2"
              style={
                h.method
                  ? {
                      background: 'var(--color-state-green)',
                      borderColor: 'var(--color-state-green)',
                      color: '#fff',
                    }
                  : {
                      background: 'var(--color-surface)',
                      borderColor: 'var(--color-line-strong)',
                      color: 'var(--color-ink-faint)',
                    }
              }
            >
              {h.method ? <Icon name="check" size={14} strokeWidth={2.6} /> : '?'}
            </span>
          ))}
        </div>

        <p className="text-lg font-bold">
          {total === 0
            ? '相続人がまだ登録されていません'
            : done
              ? '全員の判断が決まりました'
              : `${total}人中 ${decided}人が決めています`}
        </p>
      </div>

      <p className="mt-2 text-[var(--color-ink-muted)]">
        {total === 0 ? (
          '相続人になりうる方を登録すると、判断の状況をここで管理できます。'
        ) : done ? (
          '財産に関する手続きの表示が解除されました。'
        ) : (
          <>
            あと<strong>{remaining}人</strong>
            の判断が決まると、財産に関する手続きが表示されるようになります。
          </>
        )}
      </p>

      {decision.deliberationDeadline && !done && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm">
          <span className="text-[var(--color-ink-muted)]">
            判断の期限（<Term word="熟慮期間" />）
          </span>
          <strong>{formatDate(decision.deliberationDeadline)}</strong>
          {daysLeft != null && (
            <span
              className={
                daysLeft <= 14
                  ? 'font-bold text-[var(--color-state-red)]'
                  : 'text-[var(--color-ink-muted)]'
              }
            >
              （あと{daysLeft}日）
            </span>
          )}
        </p>
      )}
    </section>
  )
}
