import type { Asset, Liability } from '@aftercare/public-contracts'
import { Icon } from '@/components/ui/Icon'
import { Banner } from '@/components/ui/Banner'
import { formatYen } from '@/lib/format'

/**
 * 財産と債務の対比。
 *
 * 相続の場面でいちばん知りたいのは「いま分かっている範囲で、どちらが多いか」。
 * 金額の羅列では掴めないので、長さで見せる。
 *
 * ただしここで示すのは登録済みの金額の合計という事実だけで、
 * 「債務のほうが多いので放棄すべき」といった評価はしない。
 * 相続方法の選択は法的な判断で、士業の領域にあたるため。
 */
export function PropertyBalance({
  assets,
  liabilities,
}: {
  /** undefined は「まだ取得できていない」。空配列（＝0件）と区別する。 */
  assets?: Asset[]
  liabilities?: Liability[]
}) {
  const assetTotal = assets?.reduce((n, a) => n + (a.amount ?? 0), 0)
  const liabilityTotal = liabilities?.reduce((n, l) => n + (l.amount ?? 0), 0)
  const max = Math.max(assetTotal ?? 0, liabilityTotal ?? 0, 1)

  const loaded = [...(assets ?? []), ...(liabilities ?? [])]
  const unknownAmount = loaded.filter((x) => x.amount == null).length
  const unconfirmed = loaded.filter((x) => x.confirmation === 'UNCONFIRMED').length

  const rows = [
    {
      label: '財産',
      icon: 'bank' as const,
      total: assetTotal,
      count: assets?.length,
      color: 'var(--color-state-green)',
      soft: 'var(--color-state-green-soft)',
    },
    {
      label: '債務',
      icon: 'calculator' as const,
      total: liabilityTotal,
      count: liabilities?.length,
      color: 'var(--color-state-red)',
      soft: 'var(--color-state-red-soft)',
    },
  ]

  return (
    <section className="card p-4 sm:p-5" aria-label="財産と債務の合計">
      <h2 className="section-title">いま分かっている範囲の合計</h2>

      <div className="mt-3 flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 font-bold" style={{ color: r.color }}>
                <Icon name={r.icon} size={18} />
                {r.label}
                {r.count != null && (
                  <span className="font-normal text-[var(--color-ink-faint)]">{r.count}件</span>
                )}
              </span>
              {/* 未取得を 0 円と見せると「債務なし」と誤読されるため、金額を出さない */}
              {r.total == null ? (
                <span className="text-sm text-[var(--color-ink-faint)]">取得中…</span>
              ) : (
                <span className="text-lg font-bold tabular-nums">{formatYen(r.total)}</span>
              )}
            </div>
            <div
              className="mt-1 h-3 overflow-hidden rounded-full"
              style={{ background: r.soft }}
              role="img"
              aria-label={
                r.total == null
                  ? `${r.label}は取得中です`
                  : `${r.label}の合計 ${formatYen(r.total)}`
              }
            >
              {r.total != null && (
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${(r.total / max) * 100}%`, background: r.color }}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3.5 flex flex-col gap-2">
        {(assets == null || liabilities == null) && (
          <p className="flex gap-1.5 text-sm text-[var(--color-state-yellow)]">
            <Icon name="warning" size={16} className="mt-1 shrink-0" />
            <span>
              {assets == null ? '財産' : '債務'}をまだ読み込めていません。
              いまの表示だけで判断しないでください。
            </span>
          </p>
        )}

        {(unknownAmount > 0 || unconfirmed > 0) && (
          <p className="flex gap-1.5 text-sm text-[var(--color-ink-muted)]">
            <Icon name="info" size={16} className="mt-1 shrink-0" />
            <span>
              {unknownAmount > 0 && `金額が未入力のものが ${unknownAmount} 件`}
              {unknownAmount > 0 && unconfirmed > 0 && '、'}
              {unconfirmed > 0 && `内容が未確認のものが ${unconfirmed} 件`}
              あります。上の合計には含まれていない、または確かめられていない金額があります。
            </span>
          </p>
        )}

        <Banner tone="info">
          ここに出ているのは、登録されているものの合計です。まだ見つかっていない財産や債務がある可能性があります。
          どの相続方法を選ぶかは法的な判断になりますので、専門家にご相談ください。
        </Banner>
      </div>
    </section>
  )
}
