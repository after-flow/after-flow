import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useApprovals, useCaseOverview, useInsights, useTasks } from '@/lib/api/queries'
import type { ApprovalResource, Insight } from '@aftercare/public-contracts'
import { Icon, type IconName } from '@/kit/Icon'
import { isDisplayableInsight } from '@/lib/insights'
import { formatDate } from '@/lib/format'
import { useLogout } from '@/lib/useLogout'
import { CountPill } from '@/kit/kit'
import { useLock } from '@/kit/domain'
import { UploadDialog } from '@/screens/parts/UploadDialog'
import { useAnalysisWatcher } from './useAnalysisWatcher'
import { Tour, TourPrompt, markTourSeen, tourSeen } from './Tour'
import { ChatDockContext, type ChatDock } from './chatDock'
import { CHAT_DOCK_WIDTH, ChatDockPanel } from './ChatDockPanel'

/**
 * 画面の枠（バクラク型）。
 *
 *  左：サイドバー。上から「いま誰のケースか」→「主な操作（書類を追加）」→ メニュー。
 *  右：選んだメニューの中身だけ。
 *
 * メニューは上ほど「毎日見るもの」、下ほど「ときどき見るもの」。
 * 件数バッジは「あなたの手が必要なもの」にだけ付け、ほかの項目には数字を出さない。
 * 数字が並ぶほど、どれが大事か分からなくなるため。
 */
type NavItem = {
  to: string
  label: string
  icon: IconName
  end?: boolean
  badge?: 'tasks' | 'reviews'
  /** 画面を移らず、相談の窓を開く（to は窓を使わないときの画面） */
  opensChat?: boolean
}

const NAV: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      // ホーム（ケースを開いたときの画面）は手続きの流れ
      { to: '', label: '手続きの流れ', icon: 'path', end: true },
      { to: 'tasks', label: 'やること', icon: 'checklist', badge: 'tasks' },
      { to: 'approvals', label: 'AIからの確認', icon: 'seal', badge: 'reviews' },
    ],
  },
  {
    title: '登録した情報',
    items: [
      { to: 'documents', label: '書類', icon: 'document' },
      { to: 'property', label: '財産・契約', icon: 'wallet' },
      { to: 'family', label: '家族・相続人', icon: 'family' },
    ],
  },
  {
    title: 'サポート',
    items: [{ to: 'chat', label: 'AIに相談', icon: 'chat', opensChat: true }],
  },
]

export function useNavCounts(caseId: string) {
  const tasks = useTasks(caseId)
  const approvals = useApprovals(caseId)
  const insights = useInsights(caseId)
  const { locked } = useLock(caseId)

  // 7日以内に期限が来る「自分がやること」
  const tasksDue = (tasks.data?.items ?? []).filter(
    (t) =>
      t.status !== 'COMPLETED' &&
      !(locked && t.assetDisposal) &&
      t.deadline?.daysRemaining != null &&
      t.deadline.daysRemaining <= 7,
  ).length

  const reviews =
    (approvals.data ?? []).filter((a: ApprovalResource) => a.status === 'PENDING').length +
    (insights.data ?? []).filter((i: Insight) => i.status === 'NEW' && isDisplayableInsight(i)).length

  return { tasks: tasksDue, reviews }
}

export function AppShell() {
  const { caseId = '' } = useParams()
  const overview = useCaseOverview(caseId)
  const counts = useNavCounts(caseId)
  // 書類の読み取りが終わったら、どの画面にいても確認の件数と一覧を新しくする
  useAnalysisWatcher(caseId)
  const logout = useLogout()
  const location = useLocation()
  // ドロワーは開いたときの移動の間だけ開いている。画面を移れば（同じ画面のメニューをもう一度押しても）自然に閉じる
  const [drawerAt, setDrawerAt] = useState<string | null>(null)
  const drawer = drawerAt === location.key
  const setDrawer = (open: boolean) => setDrawerAt(open ? location.key : null)
  const [upload, setUpload] = useState(false)
  const navigate = useNavigate()
  const [tourOpen, setTourOpen] = useState(false)
  // 初回だけホームで「見ますか？」と尋ねる。答えたら（見る・あとで）二度と尋ねない
  const [askTour, setAskTour] = useState(() => !tourSeen())
  const startTour = () => {
    setAskTour(false)
    setDrawerAt(null)
    // 最初のステップはホーム（手続きの流れ）の「いまここ」を指すので、ホームで始める
    if (location.pathname !== `/cases/${caseId}`) navigate(`/cases/${caseId}`)
    setTourOpen(true)
  }

  const base = `/cases/${caseId}`
  const c = overview.data?.case

  /*
    AIに相談の窓。画面を移っても開いたままにし、書きかけの質問もここで持つ
    （窓と「AIに相談」の画面のどちらで書いても同じ文が続く）。
  */
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [pendingFocus, setPendingFocus] = useState(false)
  const lastDraft = useRef('')
  // 閉じたら、開く前にいた場所（押したボタンなど）へフォーカスを戻す
  const opener = useRef<HTMLElement | null>(null)
  const openChat = useCallback((draft?: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerAt(null)
    setChatOpen(true)
    const prev = lastDraft.current
    if (draft == null) {
      // 手続きを決めずに開いたとき（サイドバーなど）は、前の手続きの書き出しが手つかずで残っていれば消す。
      // 利用者が書き足した文は消さない
      lastDraft.current = ''
      setChatInput((cur) => (prev !== '' && cur === prev ? '' : cur))
      return
    }
    // 利用者が書いた文は消さない。空か、前の書き出しのままのときだけ差し替える
    lastDraft.current = draft
    setChatInput((cur) => (cur.trim() === '' || cur === prev ? draft : cur))
    setPendingFocus(true)
  }, [])
  const closeChat = useCallback(() => {
    setChatOpen(false)
    /*
      開いたボタンが、画面を移った・メニューを閉じたなどで消えていたら、サイドバーの「AIに相談」へ戻す
      （何もしないとフォーカスがページの先頭に飛び、キーボードや読み上げで使う方が場所を見失う）。
      サイドバーが隠れている狭い画面では focus() しても何も起きないので、そのままにする
    */
    const target = opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>('aside [data-tour="nav-chat"]')
    target?.focus()
  }, [])
  const focusHandled = useCallback(() => setPendingFocus(false), [])
  // ケースを切り替えても枠は作り直されない。別の方のケースに、書きかけの質問や開いた窓を持ち越さない
  const [chatCaseId, setChatCaseId] = useState(caseId)
  if (chatCaseId !== caseId) {
    setChatCaseId(caseId)
    setChatOpen(false)
    setChatInput('')
  }
  const chatDock = useMemo<ChatDock>(
    () => ({
      isOpen: chatOpen,
      open: openChat,
      close: closeChat,
      input: chatInput,
      setInput: setChatInput,
      pendingFocus,
      focusHandled,
    }),
    [chatOpen, openChat, closeChat, chatInput, pendingFocus, focusHandled],
  )
  // 「AIに相談」の画面にいるあいだは、同じ会話を窓にも出さない
  const onChatScreen = location.pathname === `${base}/chat`
  const dockShown = chatOpen && !onChatScreen && caseId !== ''

  const sidebar = (
    // 高さが足りない画面（横向きのスマホなど）では、メニュー全体をスクロールする。
    // メニューの項目だけをスクロールにすると、上下の固定部分に押されて項目が1つ分ほどしか見えなくなる
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-rd-primary text-white">
          <Icon name="path" size={16} strokeWidth={2} />
        </span>
        <span className="text-[1rem] font-bold tracking-wide">after-flow</span>
      </div>

      {/* いま誰のケースを見ているか */}
      <Link
        to="/cases"
        className="mx-3 flex items-center gap-2 rounded-md border border-rd-border px-3 py-2 hover:bg-rd-shade"
        title="ケースを切り替える"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.94rem] font-bold">
            {c ? `故 ${c.deceasedName} 様` : '読み込み中'}
          </span>
          <span className="block truncate text-[0.8rem] text-rd-text-2">
            {c ? `ご逝去 ${formatDate(c.dateOfDeath)}` : ' '}
          </span>
        </span>
        <Icon name="chevron-right" size={15} className="text-rd-text-3" />
      </Link>

      {/* 主な操作はひとつだけ */}
      <div className="px-3 pt-3">
        <button
          type="button"
          data-tour="upload"
          onClick={() => setUpload(true)}
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-rd-primary text-[0.97rem] font-bold text-white hover:bg-rd-primary-text"
        >
          <Icon name="upload" size={17} />
          書類を追加
        </button>
      </div>

      <nav aria-label="メインメニュー" className="flex flex-[1_0_auto] flex-col gap-4 px-3 py-4">
        {NAV.map((sec, i) => (
          <div key={sec.title ?? i}>
            {sec.title && (
              <p className="px-2.5 pb-1 text-[0.8rem] font-bold tracking-wider text-rd-text-3">
                {sec.title}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {sec.items.map((item) => {
                const n = item.badge ? counts[item.badge] : 0
                if (item.opensChat) {
                  const active = dockShown || onChatScreen
                  return (
                    <li key={item.to}>
                      <button
                        type="button"
                        data-tour={`nav-${item.to}`}
                        aria-pressed={onChatScreen ? undefined : dockShown}
                        aria-current={onChatScreen ? 'page' : undefined}
                        // 「AIに相談」の画面にいるときは、ほかのメニューで今の画面を押したときと同じく、メニューを閉じるだけにする
                        onClick={() => (dockShown ? closeChat() : onChatScreen ? setDrawerAt(null) : openChat())}
                        className={`relative flex h-10 w-full cursor-pointer items-center transition-colors duration-150 gap-2.5 rounded-md px-2.5 text-left text-[0.97rem] font-bold ${
                          active
                            ? 'bg-rd-primary-soft text-rd-primary-text before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-[3px] before:rounded-r before:bg-rd-primary'
                            : 'text-rd-text-2 hover:bg-rd-shade hover:text-rd-text'
                        }`}
                      >
                        <Icon name={item.icon} size={18} />
                        <span className="flex-1">{item.label}</span>
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to ? `${base}/${item.to}` : base}
                      end={item.end}
                      data-tour={item.to ? `nav-${item.to}` : undefined}
                      className={({ isActive }) =>
                        `relative flex h-10 items-center gap-2.5 rounded-md px-2.5 transition-colors duration-150 text-[0.97rem] font-bold ${
                          isActive
                            ? 'bg-rd-primary-soft text-rd-primary-text before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-[3px] before:rounded-r before:bg-rd-primary'
                            : 'text-rd-text-2 hover:bg-rd-shade hover:text-rd-text'
                        }`
                      }
                    >
                      <Icon name={item.icon} size={18} />
                      <span className="flex-1">{item.label}</span>
                      {n > 0 && (
                        <span aria-label={`${n}件`}>
                          <CountPill n={n} tone={item.badge === 'tasks' ? 'red' : 'blue'} />
                        </span>
                      )}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-rd-border px-3 py-3">
        <div className="flex items-center gap-2 px-1.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rd-shade text-[0.9rem] font-bold text-rd-text-2">
            {c?.ownerName.slice(0, 1) ?? ''}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.9rem] font-bold">{c?.ownerName ?? ''}</span>
            <span className="block truncate text-[0.8rem] text-rd-text-3">
              {c ? `故人の${c.relationshipToDeceased}` : ''}
            </span>
          </span>
          <button
            type="button"
            onClick={logout}
            title="ログアウト"
            aria-label="ログアウト"
            className="grid h-8 w-8 place-items-center rounded-md text-rd-text-2 hover:bg-rd-shade"
          >
            <Icon name="power" size={17} />
          </button>
        </div>
        <button
          type="button"
          onClick={startTour}
          className="mt-2 flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-[0.9rem] font-bold text-rd-text-2 hover:bg-rd-shade hover:text-rd-text"
        >
          <Icon name="info" size={17} />
          使い方を見る
        </button>
        <div className="mt-2 flex gap-3 px-1.5 text-[0.8rem] text-rd-text-3">
          <Link to="/legal/terms" className="hover:underline">利用規約</Link>
          <Link to="/legal/privacy" className="hover:underline">個人情報の取扱い</Link>
        </div>
      </div>
    </div>
  )

  return (
    <ChatDockContext.Provider value={chatDock}>
      <div
        className="flex min-h-dvh bg-rd-bg leading-normal text-rd-text"
        // 窓を横に出したとき、本文の下に固定したボタンがその分だけ右を空けるための幅（窓が右に出る sm 以上で使う）
        style={dockShown ? ({ '--chat-dock-w': CHAT_DOCK_WIDTH } as CSSProperties) : undefined}
      >
        <a href="#main" className="visually-hidden skip-link">
          本文へスキップ
        </a>

        {/* 広い画面：常設サイドバー */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-rd-border bg-rd-card lg:block">
          {sidebar}
        </aside>

        {/* 狭い画面：ドロワー。相談の窓（z-40）より上、ダイアログ（z-50）より下に出す。
            同じ z-40 だと、あとに置いた相談の窓の下に潜り、メニューの下半分（ログアウトなど）が押せなくなる */}
        {drawer && (
          <div className="fixed inset-0 z-[45] lg:hidden">
            <button
              type="button"
              aria-label="メニューを閉じる"
              className="absolute inset-0 animate-fade-in bg-black/40"
              onClick={() => setDrawer(false)}
            />
            <aside className="absolute inset-y-0 left-0 w-64 animate-drawer-in bg-rd-card shadow-xl">{sidebar}</aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-rd-border bg-rd-card px-3 lg:hidden">
            <button
              type="button"
              aria-label="メニューを開く"
              data-tour="menu"
              onClick={() => setDrawer(true)}
              className="relative grid h-10 w-10 place-items-center rounded-md hover:bg-rd-shade"
            >
              <Icon name="menu" size={22} />
              {counts.tasks + counts.reviews > 0 && (
                <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-rd-danger" />
              )}
            </button>
            <span className="min-w-0 flex-1 truncate text-[0.97rem] font-bold">
              {c ? `故 ${c.deceasedName} 様` : 'after-flow'}
            </span>
            <button
              type="button"
              data-tour="upload"
              onClick={() => setUpload(true)}
              className="flex h-9 items-center gap-1 rounded-md bg-rd-primary px-3 text-[0.9rem] font-bold text-white"
            >
              <Icon name="upload" size={15} />
              追加
            </button>
          </header>

          {/*
            @container：本文の幅で2列にするかを決める画面（手続きの画面）のため。相談の窓を横に固定すると本文が狭くなる。
            スマホで窓を下に出しているあいだは、本文の最後まで窓の上へスクロールできるよう下を空ける
          */}
          <main id="main" className={`@container min-w-0 flex-1 ${dockShown ? 'pb-[65dvh] sm:pb-0' : ''}`}>
            {/*
              画面を移ったら、中身を短くふわっと出す（どこかが変わったと分かる程度）。
              透明度だけを動かす。transform を使うと、中の position: fixed（手続きの画面の下のボタンなど）の位置がずれる
            */}
            <div key={location.pathname} className="animate-fade-in">
              <Outlet />
            </div>
          </main>
        </div>

        {dockShown && <ChatDockPanel caseId={caseId} base={base} />}

        <UploadDialog caseId={caseId} open={upload} onClose={() => setUpload(false)} />

        {/* 初回だけ、ホームで「使い方を見ますか？」と尋ねる */}
        {askTour && !tourOpen && location.pathname === base && (
          <TourPrompt
            onStart={startTour}
            onLater={() => {
              markTourSeen()
              setAskTour(false)
            }}
          />
        )}
        <Tour open={tourOpen} onClose={() => setTourOpen(false)} />
      </div>
    </ChatDockContext.Provider>
  )
}
