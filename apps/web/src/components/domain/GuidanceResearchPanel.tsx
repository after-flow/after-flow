import { useState } from 'react'
import type { Task } from '@aftercare/public-contracts'
import {
  RESEARCH_POLL_TIMEOUT_MS,
  useRequestGuidanceResearch,
  useUpdateCase,
} from '@/lib/api/queries'
import { Icon } from '@/components/ui/Icon'
import { Banner } from '@/components/ui/Banner'
import { Button, TextInput } from '@/components/ui/Primitives'
import { daysSince, formatDate, formatDateTime, msSince } from '@/lib/format'
import { safeExternalUrl, urlHostname } from '@/lib/url'

/** この日数を過ぎた調査結果は、古くなっている可能性を伝える */
const STALE_DAYS = 90

/**
 * 手順案内の自律調査（Lv4）の受け皿。
 *
 * 窓口・持ち物・受付時間は自治体ごとに異なり、変更もされる。
 * エージェントが自分で調べて埋める機能に対して、フロントエンドが引き受けるのは
 *
 *  - いま調べているのかどうかを見せる
 *  - 何を根拠にしたか（出典・確認日）を必ず示す
 *  - 確からしさが低い／調べきれなかった項目があることを隠さない
 *  - 情報が古くなったら伝え、調べ直せるようにする
 *
 * の4つ。調べた結果をそのまま信じさせないことが、この画面の役割になる。
 */
export function GuidanceResearchPanel({
  caseId,
  task,
  municipality,
}: {
  caseId: string
  task: Task
  municipality?: string
}) {
  const research = task.guidance?.research
  const sources = task.guidance?.sources ?? []
  const requestResearch = useRequestGuidanceResearch(caseId)
  const updateCase = useUpdateCase(caseId)
  const [draftMunicipality, setDraftMunicipality] = useState('')

  const status = research?.status ?? 'NOT_REQUESTED'

  // 出典のうち、いちばん新しい確認日で鮮度を判断する
  const latestCheckedAt = sources
    .map((s) => s.checkedAt)
    .sort()
    .at(-1)
  const staleDays = daysSince(latestCheckedAt)
  const isStale = staleDays != null && staleDays > STALE_DAYS

  /* ---- 調査中 ---- */
  if (status === 'RESEARCHING') {
    // 待たせすぎている場合、黙って回し続けずにやり直せるようにする
    const elapsed = msSince(research?.startedAt)
    const stuck = elapsed != null && elapsed > RESEARCH_POLL_TIMEOUT_MS

    if (stuck) {
      return (
        <Banner tone="warning" title="調査に時間がかかっています">
          <p className="text-sm">
            {research?.target ?? 'お住まいの自治体'}
            の案内をまだ確認できていません。上の案内は一般的な内容です。
          </p>
          <Button
            className="mt-2"
            size="sm"
            disabled={requestResearch.isPending}
            onClick={() => void requestResearch.mutateAsync(task.id)}
          >
            もう一度調べてもらう
          </Button>
        </Banner>
      )
    }

    return (
      <div className="rounded-lg border border-[var(--color-state-blue-line)] bg-[var(--color-state-blue-soft)] p-3">
        <p className="flex items-center gap-2 font-bold text-[var(--color-state-blue)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-state-blue-line)] border-t-[var(--color-state-blue)]" />
          {research?.target ?? 'お住まいの自治体'}の窓口を調べています
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          公開されている案内を確認しています。少し時間がかかることがあります。
          このページを開いたままにしておけば、分かり次第ここに表示されます。
        </p>
      </div>
    )
  }

  /* ---- 自治体が未登録：調べる前提が足りない ---- */
  if (!municipality) {
    return (
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3">
        <p className="flex items-center gap-2 font-bold">
          <Icon name="pin" size={18} />
          お住まいの市区町村に合わせて調べられます
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          窓口の場所や持ち物は自治体ごとに違います。市区町村をご登録いただくと、
          AIがその自治体の案内を調べてここに表示します。
          <strong>番地までは不要です。</strong>
        </p>
        <div className="mt-2.5 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <TextInput
              label="市区町村"
              hint="例：江戸川区、横浜市港北区"
              value={draftMunicipality}
              onChange={(e) => setDraftMunicipality(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            disabled={!draftMunicipality.trim() || updateCase.isPending}
            onClick={async () => {
              await updateCase.mutateAsync({ municipality: draftMunicipality.trim() })
              await requestResearch.mutateAsync(task.id)
            }}
          >
            登録して調べてもらう
          </Button>
        </div>
      </div>
    )
  }

  /* ---- まだ調べていない ---- */
  if (status === 'NOT_REQUESTED') {
    return (
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3">
        <p className="text-sm text-[var(--color-ink-muted)]">
          いまの案内は一般的な内容です。{municipality}の窓口に合わせて調べ直せます。
        </p>
        <Button
          className="mt-2"
          size="sm"
          disabled={requestResearch.isPending}
          onClick={() => void requestResearch.mutateAsync(task.id)}
        >
          <Icon name="pin" size={16} />
          {municipality}の窓口を調べてもらう
        </Button>
      </div>
    )
  }

  /* ---- 調べられなかった ---- */
  if (status === 'FAILED') {
    return (
      <Banner tone="warning" title="自治体の案内を確認できませんでした">
        <p className="text-sm">
          {research?.failureReason ??
            '公開されている案内を見つけられませんでした。'}
          上の案内は一般的な内容です。お出かけ前に{municipality}の窓口へ直接ご確認ください。
        </p>
        <Button
          className="mt-2"
          size="sm"
          disabled={requestResearch.isPending}
          onClick={() => void requestResearch.mutateAsync(task.id)}
        >
          もう一度調べてもらう
        </Button>
      </Banner>
    )
  }

  /* ---- 調べ終わった（COMPLETED / PARTIAL） ---- */
  const lowConfidence = research?.confidence === 'LOW'
  const partial = status === 'PARTIAL' || (research?.missing?.length ?? 0) > 0

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold text-[var(--color-ink-muted)]">この案内の出典</p>
          <span className="badge badge-blue">
            <Icon name="pin" size={13} />
            AIが{research?.target ?? municipality}について調べました
          </span>
          {research?.confidence === 'HIGH' && (
            <span className="badge badge-green">公式の案内で確認</span>
          )}
          {research?.confidence === 'MEDIUM' && (
            <span className="badge badge-yellow">一部は推定</span>
          )}
          {lowConfidence && <span className="badge badge-red">確認できた情報が少なめ</span>}
        </div>

        {sources.length > 0 ? (
          <ul className="mt-1.5 flex flex-col gap-1 text-sm">
            {sources.map((src, i) => {
              const safe = safeExternalUrl(src.url)
              return (
                <li key={i}>
                  {safe ? (
                    <a
                      className="font-bold text-[var(--color-brand)] underline"
                      href={safe}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {src.label}
                    </a>
                  ) : (
                    <span>{src.label}</span>
                  )}
                  <span className="ml-2 text-[var(--color-ink-faint)]">
                    {formatDate(src.checkedAt)}時点
                    {safe ? `（${urlHostname(src.url)}）` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-[var(--color-ink-faint)]">
            出典が記録されていません。内容は窓口でご確認ください。
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm text-[var(--color-ink-muted)]">
            内容が変わっている場合があります。お出かけ前に窓口へご確認ください。
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={requestResearch.isPending}
            onClick={() => void requestResearch.mutateAsync(task.id)}
          >
            最新の情報に更新する
          </Button>
        </div>

        {research?.completedAt && (
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
            AIが{formatDateTime(research.completedAt)}に調べました
          </p>
        )}
      </div>

      {/* 調べきれなかった項目を隠さない */}
      {partial && (research?.missing?.length ?? 0) > 0 && (
        <Banner tone="warning" title="確認できなかった項目があります">
          <ul className="mt-1 list-disc pl-5 text-sm">
            {research!.missing!.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-sm">この点は窓口へお電話でご確認ください。</p>
        </Banner>
      )}

      {lowConfidence && (
        <Banner tone="warning" title="この案内はそのまま信じず、窓口でご確認ください">
          <p className="text-sm">
            確認できた情報が少なく、内容が正しくない可能性があります。
            お出かけ前に{municipality}の窓口へお電話でご確認ください。
          </p>
        </Banner>
      )}

      {/* 情報が古くなっている */}
      {isStale && (
        <Banner tone="warning" title="調べてから時間が経っています">
          <p className="text-sm">
            最後に確認したのは{staleDays}日前です。窓口や持ち物が変わっている可能性があります。
          </p>
          <Button
            className="mt-2"
            size="sm"
            disabled={requestResearch.isPending}
            onClick={() => void requestResearch.mutateAsync(task.id)}
          >
            調べ直してもらう
          </Button>
        </Banner>
      )}
    </div>
  )
}
