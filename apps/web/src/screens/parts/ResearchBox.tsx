import { useState } from 'react'
import type { TaskResource } from '@aftercare/public-contracts'
import { RESEARCH_POLL_TIMEOUT_MS, useRequestGuidance, useTaskGuidance, useUpdateCase } from '@/lib/api/queries'
import { Icon } from '@/kit/Icon'
import { daysSince, formatDate, formatDateTime, msSince } from '@/lib/format'
import { safeExternalUrl, urlHostname } from '@/lib/url'
import { Badge, Button, Notice, inputClass } from '@/kit/kit'
import { AiConsentNotice, useAiConsent } from '@/kit/domain'

/** この日数を過ぎた調査結果は、古くなっている可能性を伝える */
const STALE_DAYS = 90

/**
 * 窓口・持ち物をAIが自治体ごとに調べる機能の受け皿。
 *
 * 調べた結果をそのまま信じさせないため、次のことを必ず見せる。
 *  - いま調べているのか
 *  - 出典と確認日
 *  - 調べきれなかった項目
 *  - 情報が古くなったこと
 */
export function ResearchBox({
  caseId,
  task,
  municipality,
  caseVersion,
}: {
  caseId: string
  task: TaskResource
  municipality?: string | null
  /** 市区町村の登録に使う Case の版。取得前は未定義で、その間は登録入口を無効にする。 */
  caseVersion?: number
}) {
  const guidance = useTaskGuidance(caseId, task.id)
  const g = guidance.data
  const sources = g?.sources ?? []
  const request = useRequestGuidance(caseId)
  const updateCase = useUpdateCase(caseId)
  const [draft, setDraft] = useState('')
  const status = g?.status ?? 'NOT_REQUESTED'
  const consent = useAiConsent()
  const again = () => {
    if (consent.allowed) void request.mutateAsync(task.id)
  }
  const target = g?.target ?? municipality ?? 'お住まいの自治体'

  if (status === 'RESEARCHING' || status === 'WAITING') {
    const elapsed = msSince(g?.updatedAt)
    if (elapsed != null && elapsed > RESEARCH_POLL_TIMEOUT_MS) {
      return (
        <Notice
          tone="warning"
          title="調べるのに時間がかかっています"
          action={<Button size="sm" disabled={request.isPending} onClick={again}>もう一度調べる</Button>}
        >
          {target}の案内をまだ確認できていません。上の案内は一般的な内容です。
        </Notice>
      )
    }
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-rd-primary-line bg-rd-primary-soft px-4 py-3" role="status">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-rd-primary-line border-t-rd-primary" />
        <p className="text-[0.94rem]">
          <strong className="text-rd-primary-text">{target}の窓口を調べています。</strong>
          このページを開いたままにしておけば、分かり次第ここに出ます。
        </p>
      </div>
    )
  }

  // 調べてもらう入口は、外部AIへの提供の同意がある場合だけ出す
  if (!consent.allowed && status !== 'COMPLETED' && status !== 'PARTIAL') {
    return consent.loading ? null : <AiConsentNotice feature="窓口の自動調査" />
  }

  if (!municipality) {
    return (
      <div className="rounded-lg border border-rd-border bg-rd-bg p-4">
        <p className="flex items-center gap-1.5 text-[0.94rem] font-bold">
          <Icon name="pin" size={16} />
          お住まいの市区町村に合わせて調べられます
        </p>
        <p className="mt-1 text-[0.86rem] leading-relaxed text-rd-text-2">
          窓口の場所や持ち物は自治体ごとに違います。市区町村を入れると、AIがその自治体の案内を調べます（番地は不要です）。
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-xs flex-1`}
            aria-label="市区町村"
            placeholder="例：江戸川区、横浜市港北区"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={!draft.trim() || caseVersion == null || updateCase.isPending || request.isPending}
            onClick={async () => {
              if (caseVersion == null) return
              await updateCase.mutateAsync({ expectedVersion: caseVersion, municipality: draft.trim() })
              await request.mutateAsync(task.id)
            }}
          >
            登録して調べる
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'NOT_REQUESTED') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rd-border bg-rd-bg px-4 py-3">
        <p className="text-[0.9rem] text-rd-text-2">いまの案内は一般的な内容です。</p>
        {/* 自治体名が入るので長さが決まらない。狭い画面では枠の幅で折り返す（1行のままだと枠からはみ出す） */}
        <Button
          size="sm"
          icon="pin"
          className="h-auto! min-h-9 max-w-full py-1.5 whitespace-normal!"
          disabled={request.isPending}
          onClick={again}
        >
          {municipality}の窓口を調べてもらう
        </Button>
      </div>
    )
  }

  if (status === 'FAILED') {
    return (
      <Notice
        tone="warning"
        title="自治体の案内を確認できませんでした"
        action={<Button size="sm" disabled={request.isPending} onClick={again}>もう一度調べる</Button>}
      >
        {g?.failureReason ?? '公開されている案内を見つけられませんでした。'}
        お出かけ前に{municipality}の窓口へ直接ご確認ください。
      </Notice>
    )
  }

  // COMPLETED / PARTIAL
  const latest = sources.map((s) => s.checkedAt).sort().at(-1)
  const staleDays = daysSince(latest)
  const stale = staleDays != null && staleDays > STALE_DAYS
  const missing = g?.missing ?? []

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-lg border border-rd-border bg-rd-bg p-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.86rem] font-bold text-rd-text-2">調べた情報のもと</span>
          <Badge tone="blue" icon="pin">AIが{target}について調べました</Badge>
        </div>
        {sources.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-[0.9rem]">
            {sources.map((s, i) => {
              const safe = safeExternalUrl(s.url)
              return (
                <li key={i}>
                  {safe ? (
                    <a className="font-bold text-rd-primary-text underline" href={safe} target="_blank" rel="noreferrer">
                      {s.label}
                    </a>
                  ) : (
                    s.label
                  )}
                  <span className="ml-1.5 text-rd-text-3">
                    {formatDate(s.checkedAt)}時点{safe && `（${urlHostname(s.url)}）`}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-2 text-[0.9rem] text-rd-text-3">出典が記録されていません。内容は窓口でご確認ください。</p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[0.82rem] text-rd-text-3">
          <span>
            {g?.updatedAt && `${formatDateTime(g.updatedAt)}に調査。`}
            内容が変わっている場合があります。
          </span>
          {consent.allowed && (
            <Button size="sm" variant="ghost" disabled={request.isPending} onClick={again}>
              もう一度調べる
            </Button>
          )}
        </div>
      </div>

      {missing.length > 0 && (
        <Notice tone="warning" title="確認できなかった項目があります">
          <ul className="list-disc pl-5">
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          この点は窓口へお電話でご確認ください。
        </Notice>
      )}
      {stale && (
        <Notice
          tone="warning"
          title="調べてから時間が経っています"
          action={consent.allowed ? <Button size="sm" disabled={request.isPending} onClick={again}>調べ直す</Button> : undefined}
        >
          最後に確認したのは{staleDays}日前です。
        </Notice>
      )}
    </div>
  )
}
