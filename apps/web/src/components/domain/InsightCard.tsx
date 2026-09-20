import { Link } from 'react-router-dom'
import type { Insight } from '@aftercare/public-contracts'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Primitives'
import { INSIGHT_KIND_META } from '@/lib/labels'
import { formatDateTime } from '@/lib/format'

/**
 * AIが自分で見つけた気づきを1件表示する。
 *
 * 設計上の約束ごとが3つある。いずれも法務方針に直結するため、
 * 呼び出し側の裁量にせず、このコンポーネントで固定している。
 *
 * 1. 根拠のない気づきは表示しない。
 *    利用者が自分で確かめられない指摘は、かえって判断を誤らせる。
 * 2. requiresProfessional が立っている気づきには、
 *    専門家への確認を促す注記を必ず出す（消せない）。
 *    財産の法的性質の決定や課税の判断は士業の独占業務にあたるため、
 *    エージェントの指摘は「事実の提示」までに留める必要がある。
 * 3. 操作を持たせない。
 *    気づきは情報であって、何かを実行・反映するものではない。
 */
export function InsightCard({
  caseId,
  insight,
  onAcknowledge,
  onDismiss,
  compact = false,
}: {
  caseId: string
  insight: Insight
  onAcknowledge?: () => void
  onDismiss?: () => void
  compact?: boolean
}) {
  // 根拠が無いものは出さない
  if (insight.evidence.length === 0) return null

  const meta = INSIGHT_KIND_META[insight.kind]

  return (
    <article
      className="card overflow-hidden"
      style={{ borderLeft: `5px solid ${meta.fg}` }}
      aria-label={meta.label}
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{ background: meta.bg, color: meta.fg }}
            aria-hidden
          >
            <Icon name={meta.icon} size={20} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold" style={{ color: meta.fg }}>
              {meta.label}
            </p>

            {/* AIが書いた文章であることが分かる見た目にする */}
            <p className="mt-1 whitespace-pre-wrap">{insight.body}</p>

            {/* 根拠：なぜそう考えたか */}
            <div className="mt-2.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3">
              <p className="text-sm font-bold text-[var(--color-ink-muted)]">気づいた理由</p>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {insight.evidence.map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2">
                    <span className="text-[var(--color-ink-faint)]">{e.label}：</span>
                    <span>{e.value}</span>
                    {e.documentId && (
                      <Link
                        className="font-bold text-[var(--color-brand)] underline"
                        to={`/cases/${caseId}/documents/${e.documentId}`}
                      >
                        {e.documentName ?? '書類を見る'}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/*
              法律・税務・登記・裁判所手続の判断を含む場合の注記。
              ここは消せない。AIは判断をしない、という方針の担保にあたる。
            */}
            {insight.requiresProfessional && (
              <p className="mt-2.5 flex gap-1.5 text-sm text-[var(--color-state-purple)]">
                <Icon name="star" size={16} className="mt-1 shrink-0" />
                <span>
                  これは法律・税務の判断を含みます。ここでの指摘は
                  <strong>気づきのご案内までで、判断はいたしません</strong>
                  。確定的な取り扱いは専門家にご確認ください。
                </span>
              </p>
            )}

            {!compact && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {insight.relatedTaskId && (
                  <Link
                    className="btn btn-secondary btn-sm"
                    to={`/cases/${caseId}/tasks/${insight.relatedTaskId}`}
                  >
                    {insight.relatedTaskTitle ?? '関係する手続きを見る'}
                  </Link>
                )}
                {insight.requiresProfessional && (
                  <Link className="btn btn-secondary btn-sm" to={`/cases/${caseId}/chat`}>
                    相談先について聞く
                  </Link>
                )}
                {insight.status === 'NEW' && onAcknowledge && (
                  <Button size="sm" variant="ghost" onClick={onAcknowledge}>
                    確認しました
                  </Button>
                )}
                {onDismiss && (
                  <Button size="sm" variant="ghost" onClick={onDismiss}>
                    この指摘を閉じる
                  </Button>
                )}
              </div>
            )}

            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              AIが{formatDateTime(insight.detectedAt)}に気づきました
            </p>
          </div>
        </div>
      </div>
    </article>
  )
}
