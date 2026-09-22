import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@/kit/Icon'
import { Button } from '@/kit/kit'

/**
 * 使い方のツアー。
 *
 * 利用者は急いでいることが多いので、次の約束を守る。
 *  - 勝手に始めない（初回はホームで「見ますか？」と尋ねるだけ）
 *  - 5ステップまで。1ステップ2〜3行まで
 *  - いつでも抜けられる（「終わる」・Esc・枠の外を押す）
 *  - あとから「使い方を見る」でいつでも見返せる
 *  - 説明の枠は、指し示す先に重ねない（重なると、何を指しているのか見えなくなる）
 *
 * 指し示す先は data-tour 属性で探す。広い画面ではサイドバー、狭い画面では上部のメニューを指す。
 * 見つからないとき（例：手続きが全部済んでいて「いまここ」が無い）は、画面中央に説明だけを出す。
 */
type Step = {
  /** 候補を順に探し、画面に見えている最初のものを指す */
  targets: string[]
  title: string
  body: string
  /**
   * 指し示す先が「押すと記録が切り替わる」ボタン（aria-pressed を持つ）だったときの説明。
   * いまの段階が「葬儀・火葬」のときは、押しても手続きの一覧は開かず、済んだかの記録が切り替わるため
   */
  toggleBody?: string
  /** 狭い画面でメニューの中にある場合の補足 */
  whenInMenu?: string
}

// 画面の上から順（いまの段階 → 書類を追加 → サイドバーのメニュー）に指す。行き来させない
const STEPS: Step[] = [
  {
    targets: ['flow-here'],
    title: 'いまの段階',
    body: '相続の手続きは、上から順に進みます。いまの段階に「いまここ」が付き、いちばん近い期限も出ます。押すと、その段階の手続きが見られます。',
    toggleBody: '相続の手続きは、上から順に進みます。いまの段階に「いまここ」が付きます。葬儀・火葬は、済んだらここを押して記録します。',
  },
  {
    targets: ['upload'],
    title: '書類を追加',
    body: '死亡診断書や通帳は、写真を撮って追加するだけ。AIが中身を読み取ります。',
  },
  {
    targets: ['nav-tasks', 'menu'],
    title: 'やること',
    body: 'すべての手続きが、期限の近い順に並んでいます。行き先と持ち物も、ここから見られます。',
    whenInMenu: '左上のメニューの中にあります。',
  },
  {
    targets: ['nav-approvals', 'menu'],
    title: 'AIからの確認',
    body: '書類を追加すると、AIが読み取った内容がここに届きます。合っていれば登録してください。',
    whenInMenu: '左上のメニューの中にあります。',
  },
  {
    targets: ['nav-chat', 'menu'],
    title: 'AIに相談',
    body: '分からないことは、ここから聞けます。画面の横に開くので、手続きの案内を見ながら相談できます。',
    whenInMenu: '左上のメニューの中にあります。',
  },
]

/* ---------- 「見た」の記録（ブラウザに残す。使えない環境でも動くようにする） ---------- */

const KEY = 'after-flow.tour'

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) != null
  } catch {
    return true // 記録できない環境では、毎回尋ねない
  }
}

export function markTourSeen() {
  try {
    localStorage.setItem(KEY, new Date().toISOString())
  } catch {
    /* 何もしない */
  }
}

/* ---------- 位置の計算 ---------- */

function findVisible(names: string[]): { el: HTMLElement; name: string } | null {
  for (const name of names) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return { el, name }
    }
  }
  return null
}

type Box = { top: number; left: number; width: number; height: number }
type Card = { top: number; left: number; width: number; sheet: boolean }

/** 指し示す先のまわりに空ける幅 */
const PAD = 6
const CARD_W = 360
const GAP = 14
/** 画面の端から空ける幅 */
const EDGE = 16
/** 狭い画面の固定ヘッダー（56px）の下に少し余白を足した位置 */
const HEADER_ROOM = 72
/** これより狭い画面では、説明の枠を画面の下に固定する */
const SHEET_BELOW = 640

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

/**
 * 説明の枠の置き場所。指し示す先に重ならない場所を、右 → 下 → 上 → 左 の順に探す。
 * どこにも入らなければ null（呼び出し側で指し示す先をスクロールしてから探し直す）。
 * 狭い画面では横に置く余地が無いので、画面の下に固定する（指し示す先は、その上に見えるようにスクロールする）
 */
function placeCard(box: Box | null, cardH: number): Card | null {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (vw < SHEET_BELOW) {
    const sheet = { top: vh - cardH - 12, left: 12, width: vw - 24, sheet: true }
    if (!box) return sheet
    return box.top + box.height <= sheet.top - GAP ? sheet : null
  }
  const w = Math.min(CARD_W, vw - EDGE * 2)
  if (!box) return { top: Math.max(EDGE, (vh - cardH) / 2), left: (vw - w) / 2, width: w, sheet: false }

  const midY = clamp(box.top + box.height / 2 - cardH / 2, EDGE, vh - cardH - EDGE)
  const midX = clamp(box.left + box.width / 2 - w / 2, EDGE, vw - w - EDGE)
  const right = box.left + box.width + GAP
  const below = box.top + box.height + GAP
  const above = box.top - GAP - cardH
  const left = box.left - GAP - w
  if (right + w <= vw - EDGE && cardH <= vh - EDGE * 2) return { top: midY, left: right, width: w, sheet: false }
  if (below + cardH <= vh - EDGE) return { top: below, left: midX, width: w, sheet: false }
  if (above >= EDGE) return { top: above, left: midX, width: w, sheet: false }
  if (left >= EDGE && cardH <= vh - EDGE * 2) return { top: midY, left, width: w, sheet: false }
  return null
}

/* ---------- 本体 ---------- */

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [inMenu, setInMenu] = useState(false)
  const [onToggle, setOnToggle] = useState(false)
  // 説明の枠の高さ。描いてみるまで分からないので、ふつうの高さを仮に置く
  const [cardH, setCardH] = useState(260)
  // 位置を測る処理から最新の高さを読むため（再計測のたびに作り直さない）
  const cardHRef = useRef(260)
  const cardRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const step = STEPS[i]

  const close = useCallback(() => {
    markTourSeen()
    setI(0)
    // 前回の枠の位置を覚えたままだと、次に開いたとき前回の最後の場所から枠が流れてくる。
    // 位置を忘れておけば、次は1番目の場所に直接現れる（ステップ間の移動だけ動きを付ける）
    setBox(null)
    onClose()
  }, [onClose])

  // 指し示す先を探して位置を測る。画面の切り替え直後は描画が間に合わないことがあるので、少し待って探し直す
  useLayoutEffect(() => {
    if (!open) return
    let tries = 0
    let timer: number | undefined
    const boxOf = (el: HTMLElement): Box => {
      const r = el.getBoundingClientRect()
      return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
    }
    // scroll: ステップの始めだけ、説明の枠を重ねずに置けるよう指し示す先を動かす（その後は測り直すだけ）
    const measure = (scroll: boolean) => {
      const found = findVisible(step.targets)
      if (!found && tries++ < 10) {
        timer = window.setTimeout(() => measure(scroll), 100)
        return
      }
      if (!found) {
        setBox(null)
        setInMenu(false)
        setOnToggle(false)
        return
      }
      if (scroll) {
        const b = boxOf(found.el)
        const fullyVisible = b.top >= 0 && b.top + b.height <= window.innerHeight
        if (!fullyVisible || !placeCard(b, cardHRef.current)) {
          // まず画面の中央へ。それでも置けなければ、上端（固定ヘッダーの下）へ寄せて、下に説明の場所を作る
          found.el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
          if (!placeCard(boxOf(found.el), cardHRef.current)) {
            window.scrollBy({ top: found.el.getBoundingClientRect().top - HEADER_ROOM, behavior: 'instant' as ScrollBehavior })
          }
        }
      }
      setBox(boxOf(found.el))
      setInMenu(found.name === 'menu')
      setOnToggle(found.el.hasAttribute('aria-pressed'))
    }
    measure(true)
    // 仮の高さで「置ける」と判断したあと、実際の高さでは置けないことがある。高さが分かったら（cardH が変わったら）判断し直す
    const onResize = () => {
      tries = 10
      measure(false)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, step, cardH])

  // 説明の枠の高さに合わせて置き場所を決め直す
  useLayoutEffect(() => {
    if (open && cardRef.current) {
      cardHRef.current = cardRef.current.offsetHeight
      setCardH(cardRef.current.offsetHeight)
    }
  }, [open, i, box, inMenu, onToggle])

  useEffect(() => {
    if (!open) return
    primaryRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, i, close])

  if (!open) return null

  const last = i === STEPS.length - 1
  /*
    どうしても重ならずに置けないとき（指し示す先が画面より大きいなど）は、画面の下に寄せる。
    指し示す先は上端に寄せてあるので、上の部分は見える
  */
  const cardW = Math.min(CARD_W, window.innerWidth - EDGE * 2)
  const pos: Card = placeCard(box, cardH) ?? {
    top: window.innerHeight - cardH - EDGE,
    left: (window.innerWidth - cardW) / 2,
    width: cardW,
    sheet: false,
  }

  return (
    <div className="fixed inset-0 z-[70]">
      {/* 枠の外を押すと終わる */}
      <button type="button" aria-label="使い方の説明を終わる" className="absolute inset-0 cursor-default" onClick={close} />

      {/*
        指し示す先だけを明るく残す（まわりを暗くする）。
        まだ位置を測れていない間は、全体を暗くするだけの別の要素を出す。
        key を分けておかないと React が同じ要素を使い回し、「画面全体」から枠へ形が変わる様子が
        動きとして見えてしまう（どこからともなく枠が流れてくる）。枠は毎回その場に新しく出す。
      */}
      {box ? (
        <div
          key="spot"
          aria-hidden
          className="pointer-events-none absolute rounded-xl ring-4 ring-white/90 transition-all duration-300 ease-out"
          style={{ ...box, boxShadow: '0 0 0 9999px rgba(17, 24, 39, 0.55)' }}
        />
      ) : (
        <div key="dim" aria-hidden className="pointer-events-none absolute inset-0 animate-fade-in bg-black/55" />
      )}

      <div
        // ステップが変わるたびに作り直し、短く浮き上がらせて切り替わったことを伝える
        key={i}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        // 説明が画面より高い（小さな画面・大きな文字）ときは、画面の高さに収めて枠の中をスクロールする。
        // そのままだと上が画面の外に切れ、見出しが読めない。
        // 最大の高さは画面の高さだけで決める（置き場所から決めると、高さ→置き場所→高さ…と測り直しが止まらなくなる）
        className={`absolute overflow-y-auto overscroll-contain rounded-2xl bg-rd-card p-5 shadow-2xl ${pos.sheet ? 'animate-sheet-up' : 'animate-pop-in'}`}
        style={{ top: Math.max(EDGE, pos.top), left: pos.left, width: pos.width, maxHeight: `calc(100dvh - ${EDGE * 2}px)` }}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.86rem] font-bold text-rd-primary-text">
            使い方 {i + 1} / {STEPS.length}
          </p>
          {/* いまどこまで進んだかを、点でも見せる */}
          <span aria-hidden className="flex gap-1.5">
            {STEPS.map((_, k) => (
              <span
                key={k}
                className={`h-1.5 rounded-full transition-all duration-300 ${k === i ? 'w-5 bg-rd-primary' : 'w-1.5 bg-rd-border'}`}
              />
            ))}
          </span>
        </div>
        <h2 id="tour-title" className="mt-1.5 text-[1.15rem] font-bold">
          {step.title}
        </h2>
        <p id="tour-body" className="mt-1.5 text-[0.97rem] leading-relaxed">
          {onToggle && step.toggleBody ? step.toggleBody : step.body}
        </p>
        {inMenu && step.whenInMenu && (
          <p className="mt-1.5 flex items-center gap-1 text-[0.94rem] font-bold">
            <Icon name="menu" size={17} />
            {step.whenInMenu}
          </p>
        )}

        {/* 3つ並べて入らない幅（320px の画面・大きな文字）では、進むボタンを次の行へ送る。1行に固定するとカードの外へはみ出す */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="mr-auto" onClick={close}>
            終わる
          </Button>
          {i > 0 && (
            <Button size="md" onClick={() => setI(i - 1)}>
              戻る
            </Button>
          )}
          <Button ref={primaryRef} variant="primary" size="md" onClick={() => (last ? close() : setI(i + 1))}>
            {last ? '使いはじめる' : '次へ'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 初回だけ、ホームで「使い方を見ますか？」と尋ねる（画面中央・まわりを暗くする）。勝手には始めない。
 * 答えを選ぶまで他の操作はできないので、選択肢は大きく2つだけにし、すぐ閉じられるようにする。
 * Esc・暗い部分を押したときは「あとで」と同じ扱い（二度と尋ねない。「使い方を見る」からいつでも見られる）。
 */
export function TourPrompt({ onStart, onLater }: { onStart: () => void; onLater: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null)
  // 呼び出し側は onLater を毎回作り直す。依存に入れると再描画のたびにフォーカスが「使い方を見る」へ戻り、
  // キーボードで「あとで」を選べなくなるため、参照で持つ
  const onLaterRef = useRef(onLater)
  useEffect(() => {
    onLaterRef.current = onLater
  })

  useEffect(() => {
    startRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) onLaterRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="あとで見る" className="absolute inset-0 cursor-default bg-black/55" onClick={onLater} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-prompt-title"
        // 画面より高くなる（小さな画面・大きな文字）ときは、画面の高さに収めて中をスクロールする。上が切れて見出しが読めなくならないように
        className="relative max-h-full w-full max-w-sm overflow-y-auto overscroll-contain rounded-xl bg-rd-card p-6 text-center shadow-2xl"
      >
        <span aria-hidden className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-rd-primary-soft text-rd-primary-text">
          <Icon name="info" size={24} />
        </span>
        <h2 id="tour-prompt-title" className="mt-3 text-[1.15rem] font-bold">
          はじめてお使いですか？
        </h2>
        <p className="mt-1.5 text-[0.94rem] leading-relaxed text-rd-text-2">
          30秒ほどで、画面の見方をご案内します。
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button ref={startRef} variant="primary" size="lg" onClick={onStart}>
            使い方を見る
          </Button>
          <Button size="lg" onClick={onLater}>
            あとで
          </Button>
        </div>
        <p className="mt-3 text-[0.82rem] text-rd-text-3">あとからでも、メニューの下にある「使い方を見る」から見られます。</p>
      </div>
    </div>
  )
}
