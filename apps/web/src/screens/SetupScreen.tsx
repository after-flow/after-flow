import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api/client'
import { useCaseOverview, useTasks, useUpdateCase } from '@/lib/api/queries'
import type { TaskResource } from '@aftercare/public-contracts'
import { Button, ErrorState, Field, LinkButton, Loading, Page, PageHeader, inputClass } from '@/kit/kit'
import { useCaseBase } from '@/kit/domain'
import { toast } from '@/kit/toast'

/**
 * 生年月日の登録。
 *
 * 故人の状況（健康保険・年金・仕事など）を聞く質問群は、Backend がまだ
 * Case.profile を返さない間はここに出さない（BE ユニット4待ち）。
 * それまでは、必要な手続きの洗い出しに使える生年月日だけを扱う。
 */
export function SetupScreen() {
  const { caseId, base } = useCaseBase()
  const navigate = useNavigate()
  const overview = useCaseOverview(caseId)
  const update = useUpdateCase(caseId)
  const tasks = useTasks(caseId)

  if (overview.isError) return <ErrorState message="読み込めませんでした。" onRetry={() => void overview.refetch()} />
  if (!overview.data) return <Loading />

  const { case: c } = overview.data
  // 読み込み後に初期値を決めたいので、フォームは中の部品に任せる
  return (
    <SetupForm
      key={caseId}
      initialBirth={c.dateOfBirth ?? ''}
      deathDate={c.dateOfDeath}
      expectedVersion={c.version}
      firstTime={!c.dateOfBirth}
      busy={update.isPending}
      onSkip={() => navigate(base)}
      onSubmit={async (dateOfBirth, expectedVersion) => {
        const firstTime = !c.dateOfBirth
        const before = tasks.data?.items
        await update.mutateAsync({
          expectedVersion,
          // 空にしたら消す（null を送る）。undefined だと前の生年月日が残る
          dateOfBirth: dateOfBirth || null,
        })
        // 何が変わったかを一言で知らせる（増えた手続き・不要になった手続き）
        try {
          if (!before) throw new Error('登録前の一覧が無いので比べられない')
          const after = (await api.list<TaskResource>(`/cases/${caseId}/tasks`)).items
          toast(describeChange(before, after))
        } catch {
          toast('生年月日にあわせて、必要な手続きを見直しました')
        }
        // 初回は「まずはこれ」の1件から見てもらう。登録し直したときは、変わった一覧を見てもらう
        navigate(firstTime ? base : `${base}/tasks`)
      }}
      base={base}
    />
  )
}

/** 登録前と後の手続きを比べて、変化を一言にする */
function describeChange(before: TaskResource[], after: TaskResource[]) {
  const was = new Set(before.map((t) => t.id))
  const now = new Set(after.map((t) => t.id))
  const added = after.filter((t) => !was.has(t.id))
  const removed = before.filter((t) => !now.has(t.id))
  const parts: string[] = []
  if (added.length > 0)
    parts.push(`${added.length}件増えました（${added[0].title}${added.length > 1 ? ' ほか' : ''}）`)
  if (removed.length > 0) parts.push(`${removed.length}件は不要になりました（${removed[0].title}${removed.length > 1 ? ' ほか' : ''}）`)
  return parts.length > 0 ? `手続きが${parts.join('。')}。` : '生年月日にあわせて見直しました。手続きの増減はありませんでした。'
}

function SetupForm({
  initialBirth,
  deathDate,
  expectedVersion,
  firstTime,
  busy,
  onSkip,
  onSubmit,
  base,
}: {
  initialBirth: string
  deathDate: string
  expectedVersion: number
  firstTime: boolean
  busy: boolean
  onSkip: () => void
  onSubmit: (dateOfBirth: string, expectedVersion: number) => Promise<void>
  base: string
}) {
  const [birth, setBirth] = useState(initialBirth)
  const birthError = birth && birth > deathDate ? '生年月日が、ご逝去日より後になっています' : undefined

  return (
    <Page narrow>
      <PageHeader
        back={firstTime ? undefined : { to: `${base}/tasks`, label: 'やること' }}
        title="生年月日を登録する"
        description="65歳以上・75歳以上かどうかで、必要な手続き（年金・健康保険関連）が変わります。分からない場合は、あとから何度でも直せます。"
      />

      <div className="flex flex-col gap-4">
        <section className="rounded-lg border border-rd-border bg-rd-card p-5">
          <Field label="生年月日" hint="保険証や運転免許証などで確認できます。">
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

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            variant="primary"
            size="lg"
            className="sm:flex-1"
            disabled={busy || Boolean(birthError)}
            onClick={() => void onSubmit(birth, expectedVersion)}
          >
            {busy ? '登録しています…' : 'この内容で登録する'}
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
