import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'
import { useCaseOverview, useCases, useInsights } from '@/api/queries'
import { HttpError } from '@/api/client'
import { useLogout } from '@/lib/useLogout'
import { isDisplayableInsight } from '@/lib/insights'
import { EmptyState, Spinner, ErrorState } from '@/components/ui/Primitives'
import { formatDate } from '@/lib/format'
import { Icon, type IconName } from '@/components/ui/Icon'

interface NavItem {
  to: string
  label: string
  short?: string
  icon: IconName
  end?: boolean
}

/**
 * メニューを役割で分ける。
 * 7項目を並べるだけだと、どこに何があるか覚えられない。
 */
const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: '進める',
    items: [
      { to: '', label: 'ダッシュボード', short: 'ホーム', icon: 'home', end: true },
      { to: 'tasks', label: 'タスク', icon: 'checklist' },
      { to: 'documents', label: '書類', icon: 'document' },
    ],
  },
  {
    title: '記録する',
    items: [
      { to: 'property', label: '財産・契約', short: '財産', icon: 'wallet' },
      { to: 'family', label: '家族', icon: 'family' },
    ],
  },
  {
    title: 'AIとやりとり',
    items: [
      { to: 'approvals', label: '承認', icon: 'seal' },
      { to: 'insights', label: '気づき', icon: 'star' },
      { to: 'chat', label: 'AI相談', icon: 'chat' },
    ],
  },
]

const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)

/** ボトムナビは使用頻度の高い5つに絞る */
const BOTTOM_NAV: NavItem[] = [
  NAV_ITEMS[0],
  NAV_ITEMS[1],
  NAV_ITEMS[2],
  NAV_ITEMS[3],
  NAV_ITEMS[5],
]

export function CaseLayout() {
  const { caseId = '' } = useParams()
  const navigate = useNavigate()
  const overview = useCaseOverview(caseId)
  const cases = useCases()
  const insights = useInsights(caseId)
  const [menuOpen, setMenuOpen] = useState(false)
  const logout = useLogout()

  const pendingApprovals = overview.data?.pendingApprovalCount ?? 0
  const newInsights = (insights.data?.items ?? []).filter(
    (i) => i.status === 'NEW' && isDisplayableInsight(i),
  ).length
  const notFound = overview.error instanceof HttpError && overview.error.status === 404
  const caseList = cases.data?.items ?? []

  return (
    <div className="min-h-dvh">
      <a href="#main" className="visually-hidden focus:not-sr-only">
        本文へスキップ
      </a>

      {/* ---- ヘッダー：ケース切替を常設 ---- */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <button
            type="button"
            className="btn btn-ghost btn-sm lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="case-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="menu" size={22} />
            <span className="visually-hidden">メニュー</span>
          </button>

          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span
              aria-hidden
              className="inline-block h-5 w-1.5 rounded-full bg-[var(--color-brand)]"
            />
            <span className="text-lg font-bold tracking-wide text-[var(--color-brand-strong)]">
              after-flow
            </span>
          </span>

          {/* ケースが1件だけの利用者に切替UIは不要。名前をそのまま出す */}
          {caseList.length > 1 ? (
            <label className="ml-auto flex min-w-0 items-center gap-2">
              <span className="visually-hidden">ケースの切り替え</span>
              <select
                className="select max-w-[14rem] min-w-0 text-sm"
                value={caseId}
                onChange={(e) => navigate(`/cases/${e.target.value}`)}
              >
                {caseList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.deceasedName}（{formatDate(c.dateOfDeath)}）
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="ml-auto min-w-0 truncate text-sm text-[var(--color-ink-muted)]">
              {overview.data?.case.deceasedName
                ? `${overview.data.case.deceasedName} 様のケース`
                : ''}
            </span>
          )}

          <NavLink to="/cases" className="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            一覧
          </NavLink>
          <button
            type="button"
            className="btn btn-ghost btn-sm hidden shrink-0 whitespace-nowrap sm:inline-flex"
            onClick={logout}
          >
            ログアウト
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-7 px-4 py-6">
        {/* ---- サイドメニュー（PC） / ハンバーガー（スマートフォン） ---- */}
        <nav
          id="case-nav"
          aria-label="ケース内のメニュー"
          className={`${menuOpen ? 'block' : 'hidden'} fixed inset-x-0 top-[3.6rem] z-30 border-b border-[var(--color-line)] bg-[var(--color-surface)] p-3 lg:static lg:block lg:w-56 lg:shrink-0 lg:border-0 lg:bg-transparent lg:p-0`}
        >
          <div className="flex flex-col gap-4">
            {NAV_SECTIONS.map((section) => (
              <div key={section.title}>
                <p className="eyebrow mb-1 px-3 lg:px-3">{section.title}</p>
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to ? `/cases/${caseId}/${item.to}` : `/cases/${caseId}`}
                        end={item.end}
                        onClick={() => setMenuOpen(false)}
                        className={({ isActive }) =>
                          `relative flex items-center gap-2.5 rounded-lg px-3 py-2.5 font-bold transition-colors ${
                            isActive
                              ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-strong)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r before:bg-[var(--color-brand)]'
                              : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-state-gray-soft)] hover:text-[var(--color-ink)]'
                          }`
                        }
                      >
                        <Icon name={item.icon} size={19} />
                        {item.label}
                        {item.to === 'approvals' && pendingApprovals > 0 && (
                          <span className="badge badge-yellow ml-auto">{pendingApprovals}</span>
                        )}
                        {item.to === 'insights' && newInsights > 0 && (
                          <span className="badge badge-purple ml-auto">{newInsights}</span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left font-bold text-[var(--color-ink-muted)] hover:bg-[var(--color-state-gray-soft)] sm:hidden"
              onClick={logout}
            >
              <Icon name="power" size={19} />
              ログアウト
            </button>

            {/*
              同意したあとも、何に同意したのかをいつでも確認できるようにしておく。
              個人情報の取扱いは、同意時だけ見せて終わりにしない。
            */}
            <div className="mt-1 flex flex-col gap-1 border-t border-[var(--color-line)] px-3 pt-3 text-sm">
              <Link className="text-[var(--color-ink-faint)] underline" to="/legal/terms">
                利用規約
              </Link>
              <Link className="text-[var(--color-ink-faint)] underline" to="/legal/privacy">
                個人情報の取扱いについて
              </Link>
              <Link className="text-[var(--color-ink-faint)] underline" to="/consent">
                同意した内容を確認する
              </Link>
            </div>
          </div>
        </nav>

        <main id="main" className="min-w-0 flex-1 pb-20 lg:pb-0">
          {/*
            分岐は必ずどれかに当たるようにする。
            以前は isLoading / isError / data のどれにも当てはまらない状態
            （取得が一時停止した場合など）で本文が真っ白になっていた。
          */}
          {overview.data ? (
            <Outlet context={{ caseId }} />
          ) : notFound ? (
            <EmptyState
              title="このケースは見つかりませんでした"
              description="削除されたか、URLが正しくない可能性があります。ケース一覧からお選びください。"
              action={
                <Link className="btn btn-primary" to="/cases">
                  ケース一覧へ戻る
                </Link>
              }
            />
          ) : overview.isError ? (
            <ErrorState
              message="ケース情報の取得に失敗しました。通信環境をご確認ください。"
              onRetry={() => void overview.refetch()}
            />
          ) : (
            <Spinner label="ケース情報を読み込み中" />
          )}
        </main>
      </div>

      {/* ---- ボトムナビ（スマートフォン） ---- */}
      <nav
        aria-label="主要メニュー"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-line)] bg-[var(--color-surface)] lg:hidden"
      >
        {BOTTOM_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to ? `/cases/${caseId}/${item.to}` : `/cases/${caseId}`}
            end={item.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-bold ${
                isActive ? 'text-[var(--color-brand-strong)]' : 'text-[var(--color-ink-faint)]'
              }`
            }
          >
            <Icon name={item.icon} size={21} />
            {item.short ?? item.label}
            {item.to === 'approvals' && pendingApprovals > 0 && (
              <span className="absolute right-3 top-1 h-2.5 w-2.5 rounded-full bg-[var(--color-state-red)]" />
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
