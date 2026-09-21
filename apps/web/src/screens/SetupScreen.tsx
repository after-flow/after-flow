import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api/client'
import { useCaseOverview, useTasks, useUpdateCase } from '@/lib/api/queries'
import type { CaseProfile, Paginated, Task, YesNoUnknown } from '@aftercare/public-contracts'
import { Button, ErrorState, Field, LinkButton, Loading, Page, PageHeader, inputClass } from '@/kit/kit'
import { useCaseBase } from '@/kit/domain'
import { toast } from '@/kit/toast'

/**
 * 故人の状況を聞く質問。
 *
 * 必要な手続きは人によって違う（年金を受け取っていたか、持ち家があるか…）。
 * 何も聞かないと関係の無い手続きまで並ぶか、逆に漏れる。
 * ここで答えてもらい、Rule Engine があてはまる手続きだけを洗い出す。
 *
 * どれも「わからない」で構わない。わからない項目は、あてはまる可能性があるものとして扱い、
 * 手続きの説明に「あてはまる場合に必要です」と添える。
 */
type Choice<T extends string> = { value: T; label: string }

const HEALTH: Choice<NonNullable<CaseProfile['healthInsurance']>>[] = [
  { value: 'NATIONAL', label: '国民健康保険' },
  { value: 'EMPLOYEE', label: '会社の健康保険（家族として入っていた場合も）' },
  { value: 'LATE_ELDERLY', label: '後期高齢者医療（75歳以上）' },
  { value: 'UNKNOWN', label: 'わからない' },
]
const PENSION: Choice<NonNullable<CaseProfile['pension']>>[] = [
  { value: 'EMPLOYEES', label: '受け取っていた（厚生年金を含む）' },
  { value: 'NATIONAL_ONLY', label: '受け取っていた（国民年金だけ）' },
  { value: 'NONE', label: '受け取っていなかった' },
  { value: 'UNKNOWN', label: 'わからない' },
]
const WORK: Choice<NonNullable<CaseProfile['occupation']>>[] = [
  { value: 'EMPLOYEE', label: '会社員・公務員として働いていた' },
  { value: 'SELF_EMPLOYED', label: '自営業だった' },
  { value: 'NONE', label: '働いていなかった' },
  { value: 'UNKNOWN', label: 'わからない' },
]
const YES_NO: Choice<YesNoUnknown>[] = [
  { value: 'YES', label: 'はい' },
  { value: 'NO', label: 'いいえ' },
  { value: 'UNKNOWN', label: 'わからない' },
]

export function SetupScreen() {
  const { caseId, base } = useCaseBase()
  const navigate = useNavigate()
  const overview = useCaseOverview(caseId)
  const update = useUpdateCase(caseId)
  const tasks = useTasks(caseId)

  if (overview.isError) return <ErrorState message="読み込めませんでした。" onRetry={() => void overview.refetch()} />
  if (!overview.data) return <Loading />

  // 読み込み後に初期値を決めたいので、フォームは中の部品に任せる
  return (
    <SetupForm
      key={caseId}
      initialBirth={overview.data.case.dateOfBirth ?? ''}
      initial={overview.data.case.profile ?? {}}
      deathDate={overview.data.case.dateOfDeath}
      firstTime={!overview.data.case.profile?.answeredAt}
      busy={update.isPending}
      onSkip={() => navigate(base)}
      onSubmit={async (dateOfBirth, profile) => {
        const firstTime = !overview.data?.case.profile?.answeredAt
        const before = tasks.data?.items
        await update.mutateAsync({
          // 空にしたら消す（null を送る）。undefined だと前の生年月日が残る
          dateOfBirth: dateOfBirth || null,
          profile: { ...profile, answeredAt: new Date().toISOString() },
        })
        // 何が変わったかを一言で知らせる（増えた手続き・不要になった手続き）
        try {
          if (!before) throw new Error('答える前の一覧が無いので比べられない')
          const after = (await api.get<Paginated<Task>>(`/cases/${caseId}/tasks`)).items
          toast(describeChange(before, after))
        } catch {
          toast('答えにあわせて、必要な手続きを洗い出しました')
        }
        // 初回はホーム（手続きの流れ）で、いまの段階から見てもらう。答え直したときは、変わった一覧を見てもらう
        navigate(firstTime ? base : `${base}/tasks`)
      }}
      base={base}
    />
  )
}

/** 答える前と後の手続きを比べて、変化を一言にする */
function describeChange(before: Task[], after: Task[]) {
  const was = new Set(before.map((t) => t.id))
  const now = new Set(after.map((t) => t.id))
  const added = after.filter((t) => !was.has(t.id))
  const removed = before.filter((t) => !now.has(t.id))
  const parts: string[] = []
  if (added.length > 0)
    parts.push(`${added.length}件増えました（${added[0].title}${added.length > 1 ? ' ほか' : ''}）`)
  if (removed.length > 0) parts.push(`${removed.length}件は不要になりました（${removed[0].title}${removed.length > 1 ? ' ほか' : ''}）`)
  return parts.length > 0 ? `手続きが${parts.join('。')}。` : '答えにあわせて見直しました。手続きの増減はありませんでした。'
}

function SetupForm({
  initialBirth,
  initial,
  deathDate,
  firstTime,
  busy,
  onSkip,
  onSubmit,
  base,
}: {
  initialBirth: string
  initial: CaseProfile
  deathDate: string
  firstTime: boolean
  busy: boolean
  onSkip: () => void
  onSubmit: (dateOfBirth: string, profile: CaseProfile) => Promise<void>
  base: string
}) {
  const [birth, setBirth] = useState(initialBirth)
  const [profile, setProfile] = useState<CaseProfile>(initial)
  const set = <K extends keyof CaseProfile>(k: K, v: CaseProfile[K]) => setProfile((prev) => ({ ...prev, [k]: v }))
  const birthError = birth && birth > deathDate ? '生年月日が、ご逝去日より後になっています' : undefined

  return (
    <Page narrow>
      <PageHeader
        back={firstTime ? undefined : { to: `${base}/tasks`, label: 'やること' }}
        title={firstTime ? '亡くなった方のことを、少し教えてください' : 'あてはまる手続きを見直す'}
        description="答えにあわせて、必要な手続きだけを洗い出します。分からない質問は「わからない」のままで構いません。あとから何度でも直せます。"
      />

      <div className="flex flex-col gap-4">
        <section className="rounded-lg border border-rd-border bg-rd-card p-5">
          <Field label="1. 生年月日" hint="65歳以上・75歳以上かどうかで、必要な手続きが変わります。">
            {(id) => (
              <input
                id={id}
                type="date"
                max={deathDate}
                className={`${inputClass} max-w-xs`}
                aria-invalid={Boolean(birthError)}
                value={birth}
                onChange={(e) => setBirth(e.target.value)}
              />
            )}
          </Field>
          {birthError && <p className="mt-1 text-[0.86rem] font-bold text-rd-danger-text">{birthError}</p>}
        </section>

        <Question
          no={2}
          title="入っていた健康保険"
          hint="保険証に書いてある名前で分かります。"
          choices={HEALTH}
          value={profile.healthInsurance}
          onChange={(v) => set('healthInsurance', v)}
        />
        <Question
          no={3}
          title="年金を受け取っていましたか"
          hint="会社員として働いた期間があれば、厚生年金を受け取っていることが多いです。"
          choices={PENSION}
          value={profile.pension}
          onChange={(v) => set('pension', v)}
        />
        <Question
          no={4}
          title="亡くなる前のお仕事"
          choices={WORK}
          value={profile.occupation}
          onChange={(v) => set('occupation', v)}
        />
        <Question
          no={5}
          title="故人名義の家や土地はありますか"
          hint="あれば、名義を変える手続き（相続登記）が義務になります。"
          choices={YES_NO}
          value={profile.realEstate}
          onChange={(v) => set('realEstate', v)}
        />
        <Question
          no={6}
          title="故人名義の自動車はありますか"
          choices={YES_NO}
          value={profile.car}
          onChange={(v) => set('car', v)}
        />
        <Question
          no={7}
          title="住宅ローンはありましたか"
          hint="保険で残りが返済されることがあります。"
          choices={YES_NO}
          value={profile.mortgage}
          onChange={(v) => set('mortgage', v)}
        />

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            variant="primary"
            size="lg"
            className="sm:flex-1"
            disabled={busy || Boolean(birthError)}
            onClick={() => void onSubmit(birth, profile)}
          >
            {busy ? '洗い出しています…' : 'この内容で手続きを洗い出す'}
          </Button>
          {firstTime ? (
            <Button size="lg" onClick={onSkip}>
              あとで答える
            </Button>
          ) : (
            <LinkButton to={`${base}/tasks`} size="lg">
              やめる
            </LinkButton>
          )}
        </div>
      </div>
    </Page>
  )
}

function Question<T extends string>({
  no,
  title,
  hint,
  choices,
  value,
  onChange,
}: {
  no: number
  title: string
  hint?: string
  choices: Choice<T>[]
  value?: T
  onChange: (v: T) => void
}) {
  return (
    <fieldset className="rounded-lg border border-rd-border bg-rd-card p-5">
      <legend className="sr-only">{title}</legend>
      <p aria-hidden className="text-[0.94rem] font-bold">
        {no}. {title}
      </p>
      {hint && <p className="mt-0.5 text-[0.86rem] text-rd-text-2">{hint}</p>}
      <div role="radiogroup" aria-label={title} className="mt-3 grid gap-2 sm:grid-cols-2">
        {choices.map((c) => {
          const on = value === c.value
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(c.value)}
              className={`flex min-h-12 items-center gap-2.5 rounded-md border px-3.5 py-2 text-left text-[0.94rem] ${
                on
                  ? 'border-rd-primary bg-rd-primary-soft font-bold text-rd-primary-text'
                  : 'border-rd-border hover:bg-rd-shade'
              }`}
            >
              <span
                aria-hidden
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-rd-primary' : 'border-rd-text-3'}`}
              >
                {on && <span className="h-2.5 w-2.5 rounded-full bg-rd-primary" />}
              </span>
              {c.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
