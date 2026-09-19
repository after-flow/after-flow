import { Link, useNavigate } from 'react-router-dom'
import { useCases } from '@/api/queries'
import { useLogout } from '@/lib/useLogout'
import { Button, Card, EmptyState, ErrorState, Spinner } from '@/components/ui/Primitives'
import { formatDate } from '@/lib/format'

export function CaseListPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, refetch } = useCases()
  const logout = useLogout()

  return (
    <div className="mx-auto max-w-3xl p-4 py-6">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">after-flow</p>
          <h1 className="mt-0.5 text-[1.55rem] font-bold">ケース一覧</h1>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={logout}
        >
          ログアウト
        </button>
      </header>

      {isLoading && <Spinner />}
      {isError && <ErrorState message="ケース一覧を取得できませんでした。" onRetry={() => void refetch()} />}

      {data && data.items.length === 0 && (
        <Card>
          <EmptyState
            title="まだケースがありません"
            description="お亡くなりになった方ごとにケースを作成すると、必要な手続きと期限を整理できます。"
            action={
              <Link className="btn btn-primary" to="/cases/new">
                ケースを作成する
              </Link>
            }
          />
        </Card>
      )}

      {data && data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-3">
            {data.items.map((c) => (
              <li key={c.id}>
                <Link to={`/cases/${c.id}`} className="row-card p-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[1.2rem] font-bold">{c.deceasedName} 様</span>
                    {c.status === 'CLOSED' && <span className="badge badge-gray">完了</span>}
                  </div>
                  <dl className="mt-2 flex flex-wrap gap-x-7 gap-y-1 text-sm text-[var(--color-ink-muted)]">
                    <div className="flex gap-2">
                      <dt className="font-bold">ご逝去日</dt>
                      <dd>{formatDate(c.dateOfDeath)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-bold">ご関係</dt>
                      <dd>
                        {c.relationshipToDeceased}（{c.ownerName} 様）
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <Button variant="primary" onClick={() => navigate('/cases/new')}>
              ケースを追加する
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
