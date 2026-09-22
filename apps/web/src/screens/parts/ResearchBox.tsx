import { useState } from 'react'
import type { KyoukaikenpoBurialBenefitResource, TaskResource } from '@aftercare/public-contracts'
import { RESEARCH_POLL_TIMEOUT_MS, useForceRestartGuidance, useRequestGuidance, useTaskGuidance, useUpdateCase } from '@/lib/api/queries'
import { Icon } from '@/kit/Icon'
import { daysSince, formatDate, formatDateTime, msSince } from '@/lib/format'
import { safeExternalUrl, urlHostname } from '@/lib/url'
import { Badge, Button, Field, Notice, inputClass } from '@/kit/kit'
import { AiConsentNotice, useAiConsent } from '@/kit/domain'
import { guidanceDisplayState } from '@/lib/model/guidance'
import { mergeKyoukaikenpoBurialBenefitInput } from '@/lib/model/kyoukaikenpo-burial-benefit'

/** この日数を過ぎた調査結果は、古くなっている可能性を伝える */
const STALE_DAYS = 90

/**
 * 行き先・持ち物をAIが地域に合わせて調べる機能の受け皿。
 *
 * 調べた結果をそのまま信じさせないため、次のことを必ず見せる。
 *  - いま調べているのか
 *  - 出典と確認日
 *  - 調べきれなかった項目
 *  - 情報が古くなったこと
 *  - 調べずに終わったのか（情報不足・情報源未設定・失敗）
 */
export function ResearchBox({
  caseId,
  task,
  municipality,
  caseBasicInfoVersion,
  kyoukaikenpoBurialBenefit,
}: {
  caseId: string
  task: TaskResource
  municipality?: string | null
  /** 市区町村・協会けんぽ情報の登録に使う Case の基本情報版。取得前は未定義で、その間は登録入口を無効にする。 */
  caseBasicInfoVersion?: number
  kyoukaikenpoBurialBenefit?: KyoukaikenpoBurialBenefitResource
}) {
  const guidance = useTaskGuidance(caseId, task.id)
  const g = guidance.data
  const sources = g?.sources ?? []
  const request = useRequestGuidance(caseId)
  const forceRestart = useForceRestartGuidance(caseId)
  const updateCase = useUpdateCase(caseId)
  const [draft, setDraft] = useState('')
  const [branch, setBranch] = useState('')
  const [deceasedInsuranceStatus, setDeceasedInsuranceStatus] = useState<'' | 'INSURED' | 'DEPENDENT'>('')
  const [applicantStatus, setApplicantStatus] = useState<'' | 'LIVELIHOOD_MAINTAINER' | 'BURIAL_EXPENSE_PAYER'>('')
  const [researchRestartFailed, setResearchRestartFailed] = useState(false)
  const status = g?.status ?? 'NOT_REQUESTED'
  const consent = useAiConsent()
  const again = () => {
    if (consent.allowed) void request.mutateAsync(task.id)
  }
  // 何について調べたか。Backend の案内は手続きの名前を返す（自治体名ではない）。
  const target = g?.target ?? task.title
  // 提出先は Backend の正式データだけを使う。手続きによって税務署・年金事務所・勤務先などで、
  // 自治体の窓口とは限らない。分からないものを「自治体の窓口」と決めつけない。
  const destination = task.submitTo ?? null
  const state = guidanceDisplayState(g)
  const researched = state === 'RESEARCHED'

  if (state === 'RESEARCHING') {
    const elapsed = msSince(g?.updatedAt)
    if (elapsed != null && elapsed > RESEARCH_POLL_TIMEOUT_MS) {
      const restart = () => {
        if (consent.allowed && g?.agentRunId) {
          void forceRestart.mutateAsync({ taskId: task.id, runId: g.agentRunId })
        }
      }
      return (
        <Notice
          tone="warning"
          title="調べるのに時間がかかっています"
          action={<Button size="sm" disabled={!consent.allowed || forceRestart.isPending || !g?.agentRunId} onClick={restart}>キャンセルしてやり直す</Button>}
        >
          {target}の案内をまだ確認できていません。上の案内は一般的な内容です。
        </Notice>
      )
    }
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-rd-primary-line bg-rd-primary-soft px-4 py-3" role="status">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-rd-primary-line border-t-rd-primary" />
        <p className="text-[0.94rem]">
          <strong className="text-rd-primary-text">{target}の案内を調べています。</strong>
          このページを開いたままにしておけば、分かり次第ここに出ます。
        </p>
      </div>
    )
  }

  // 調べてもらう入口は、外部AIへの提供の同意がある場合だけ出す
  if (!consent.allowed && status !== 'COMPLETED' && status !== 'PARTIAL') {
    return consent.loading ? null : <AiConsentNotice feature="窓口の自動調査" />
  }

  // 自動で調べられない手続きは、市区町村を聞いても結果が変わらない。先に伝えて入力を求めない。
  if (state === 'NOT_RESEARCHABLE') {
    return (
      <Notice tone="info" title="この手続きは自動で調べられません">
        公式の案内を自動で確認できる手続きではありません。上の案内は一般的な内容です。
        <ConfirmAtDestination destination={destination} />
      </Notice>
    )
  }

  if (
    state === 'MISSING_CONTEXT' &&
    task.procedureId === 'kyoukaikenpo-burial-benefit' &&
    kyoukaikenpoBurialBenefit
  ) {
    const missingFields = kyoukaikenpoBurialBenefit.missingFields
    const needsBranch = missingFields.includes('BRANCH')
    const needsDeceasedStatus = missingFields.includes('DECEASED_INSURANCE_STATUS')
    const needsApplicantStatus = missingFields.includes('APPLICANT_STATUS')
    const complete = (!needsBranch || branch.trim().length > 0)
      && (!needsDeceasedStatus || deceasedInsuranceStatus !== '')
      && (!needsApplicantStatus || applicantStatus !== '')

    const restart = async () => {
      setResearchRestartFailed(false)
      try {
        await request.mutateAsync(task.id)
      } catch {
        setResearchRestartFailed(true)
      }
    }

    if (missingFields.length === 0) {
      return (
        <div className="flex flex-col gap-2.5">
          {researchRestartFailed && (
            <Notice tone="warning" role="alert">
              情報は保存済みだが再調査を開始できなかった
            </Notice>
          )}
          <Button size="sm" disabled={request.isPending} onClick={() => void restart()}>
            情報は登録済み。もう一度調べる
          </Button>
        </div>
      )
    }

    return (
      <div className="rounded-lg border border-rd-warning-line bg-rd-warning-soft p-4">
        <p className="font-bold text-rd-warning-text">情報を追加すると、より具体的に調べられます</p>
        <p className="mt-1 text-[0.86rem] leading-relaxed text-rd-text-2">
          未入力のままでも、公式情報から分かる範囲を調べられます。
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {needsBranch && (
            <Field label="加入していた協会けんぽの支部" required>
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={branch}
                  placeholder="例：東京支部"
                  onChange={(event) => setBranch(event.target.value)}
                />
              )}
            </Field>
          )}
          {needsDeceasedStatus && (
            <Field label="亡くなった方の加入状況" required>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={deceasedInsuranceStatus}
                  onChange={(event) => setDeceasedInsuranceStatus(event.target.value as typeof deceasedInsuranceStatus)}
                >
                  <option value="">選択してください</option>
                  <option value="INSURED">被保険者本人</option>
                  <option value="DEPENDENT">被扶養者</option>
                </select>
              )}
            </Field>
          )}
          {needsApplicantStatus && (
            <Field label="申請する方の状況" required>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={applicantStatus}
                  onChange={(event) => setApplicantStatus(event.target.value as typeof applicantStatus)}
                >
                  <option value="">選択してください</option>
                  <option value="LIVELIHOOD_MAINTAINER">亡くなった方により生計を維持されていた</option>
                  <option value="BURIAL_EXPENSE_PAYER">埋葬にかかった費用を支払った</option>
                </select>
              )}
            </Field>
          )}
          {researchRestartFailed && (
            <Notice tone="warning" role="alert">
              情報は保存済みだが再調査を開始できなかった
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!complete || caseBasicInfoVersion == null || updateCase.isPending || request.isPending}
              onClick={async () => {
                if (caseBasicInfoVersion == null) return
                setResearchRestartFailed(false)
                try {
                  await updateCase.mutateAsync({
                    expectedVersion: caseBasicInfoVersion,
                    kyoukaikenpoBurialBenefit: mergeKyoukaikenpoBurialBenefitInput(
                      kyoukaikenpoBurialBenefit,
                      { branch, deceasedInsuranceStatus, applicantStatus },
                    ),
                  })
                } catch {
                  return
                }
                try {
                  await request.mutateAsync(task.id)
                } catch {
                  setResearchRestartFailed(true)
                }
              }}
            >
              保存して詳しく調べる
            </Button>
            <Button disabled={request.isPending} onClick={() => void restart()}>
              このまま分かる範囲で調べる
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!municipality && state === 'NOT_REQUESTED') {
    return (
      <div className="rounded-lg border border-rd-border bg-rd-bg p-4">
        <p className="flex items-center gap-1.5 text-[0.94rem] font-bold">
          <Icon name="pin" size={16} />
          お住まいの地域に合わせて調べられます
        </p>
        <p className="mt-1 text-[0.86rem] leading-relaxed text-rd-text-2">
          市区町村を入れると、地域に合った案内を調べられます（番地は不要です）。未入力でも、公式情報から分かる範囲を調べます。
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
            disabled={!draft.trim() || caseBasicInfoVersion == null || updateCase.isPending || request.isPending}
            onClick={async () => {
              if (caseBasicInfoVersion == null) return
              await updateCase.mutateAsync({ expectedVersion: caseBasicInfoVersion, municipality: draft.trim() })
              await request.mutateAsync(task.id)
            }}
          >
            登録して詳しく調べる
          </Button>
          <Button disabled={request.isPending} onClick={again}>
            このまま分かる範囲で調べる
          </Button>
        </div>
      </div>
    )
  }

  if (state === 'NOT_REQUESTED') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rd-border bg-rd-bg px-4 py-3">
        <p className="text-[0.9rem] text-rd-text-2">いまの案内は一般的な内容です。</p>
        {/* 手続きの名前が入るので長さが決まらない。狭い画面では枠の幅で折り返す（1行のままだと枠からはみ出す） */}
        <Button
          size="sm"
          icon="pin"
          className="h-auto! min-h-9 max-w-full py-1.5 whitespace-normal!"
          disabled={request.isPending}
          onClick={again}
        >
          {municipality}に合わせて調べてもらう
        </Button>
      </div>
    )
  }

  if (state === 'FAILED') {
    return (
      <Notice
        tone="warning"
        title="この手続きの案内を確認できませんでした"
        action={<Button size="sm" disabled={request.isPending} onClick={again}>もう一度調べる</Button>}
      >
        {g?.failureReason ?? '公開されている案内を見つけられませんでした。'}
        <ConfirmAtDestination destination={destination} />
      </Notice>
    )
  }

  // 事前に終了した調査は「調べた結果」ではない。出典も無いので、そのように見せない。
  if (state === 'MISSING_CONTEXT') {
    return (
      <Notice
        tone="warning"
        title="情報が不足しているため、前回は調査できませんでした"
        action={<Button size="sm" disabled={request.isPending} onClick={again}>分かる範囲で調べ直す</Button>}
      >
        現在の情報のままでも、公式情報から一般的な手続きと条件を調べ直せます。
        <ConfirmAtDestination destination={destination} />
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
          {/* 実際に公式の情報源を調べたときだけ「AIが調べました」と言う。事前終了や出典なしでは言わない。 */}
          {researched && <Badge tone="blue" icon="pin">AIが{target}について調べました</Badge>}
        </div>
        {researched ? (
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
          <p className="mt-2 text-[0.9rem] text-rd-text-3">
            確認できる出典がありません。上の案内は一般的な内容です。
            {destination ? `${destination}へ直接ご確認ください。` : '提出先へ直接ご確認ください。'}
          </p>
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
          この点は{destination ?? '提出先'}へお電話でご確認ください。
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

/**
 * 確かめ先の案内。
 *
 * 提出先は Backend が持っている手続きごとの正式データだけを使う。
 * 登録が無い手続きで「自治体の窓口へ」と補わない（税務署・年金事務所・
 * 勤務先など、手続きによって提出先は違う）。
 */
function ConfirmAtDestination({ destination }: { destination: string | null }) {
  return destination ? <>{destination}へ直接ご確認ください。</> : <>提出先へ直接ご確認ください。</>
}
