import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@/kit/Icon'
import { Button } from '@/kit/kit'

/**
 * 使い方のツアー。
 *
 * 利用者は急いでいることが多いので、次の約束を守る。
 *  - 勝手に始めない（初回はホームで「見ますか？」と尋ねるだけ）
 *  - 4ステップまで。1ステップ2行まで
 *  - いつでも抜けられる（「終わる」・Esc・枠の外を押す）
 *  - あとから「使い方を見る」でいつでも見返せる
 *
 * 指し示す先は data-tour 属性で探す。広い画面ではサイドバー、狭い画面では上部のメニューを指す。
 * 見つからないとき（例：手続きが全部済んでいて「まずはこれ」が無い）は、画面中央に説明だけを出す。
 */
type Step = {
  /** 候補を順に探し、画面に見えている最初のものを指す */
  targets: string[]
  title: string
  body: string
  /** 狭い画面でメニューの中にある場合の補足 */
  whenInMenu?: string
}

// 画面の上から順（サイドバーの並び：書類を追加 → やること → AIからの確認）に指す。行き来させない
const STEPS: Step[] = [
  {
    targets: ['first-task'],
    title: 'まずはこれ',
    body: 'いちばん急ぐ手続きがここに出ます。「やり方を見る」で、行き先と持ち物が分かります。',
  },
  {
    targets: ['upload'],
    title: '書類を追加',
    body: '死亡診断書や通帳は、写真を撮って追加するだけ。AIが中身を読み取ります。',
  },
  {
    targets: ['nav-tasks', 'menu'],
    title: 'やること',
    body: 'すべての手続きが、期限の近い順に並んでいます。「まずはこれ」は、この一番上の1件です。',
    whenInMenu: '左上のメニューの中にあります。',
  },
  {
    targets: ['nav-approvals', 'menu'],
    title: 'AIからの確認',
    body: '書類を追加すると、AIが読み取った内容がここに届きます。合っていれば登録してください。迷ったら「AIに相談」で聞けます。',
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

const PAD = 6
const CARD_W = 340
const GAP = 12
/** 狭い画面の固定ヘッダー（56px）の下に少し余白を足した位置 */
const HEADER_ROOM = 72

/** 説明の枠を、指し示す先の右・下・上のうち空いている場所に置く */
function placeCard(box: Box | null, cardH: number) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(CARD_W, vw - 32)
  if (!box) return { top: Math.max(16, (vh - cardH) / 2), left: (vw - w) / 2, width: w }

  const clampLeft = (l: number) => Math.min(Math.max(16, l), vw - w - 16)
  const clampTop = (t: number) => Math.min(Math.max(16, t), vh - cardH - 16)

  // 左端のサイドバーを指すときは右側に
  if (box.left + box.width < vw * 0.3 && box.left + box.width + GAP + w < vw - 16) {
    return { top: clampTop(box.top + box.height / 2 - cardH / 2), left: box.left + box.width + GAP, width: w }
  }
  // 下に入るなら下、入らなければ上
  if (box.top + box.height + GAP + cardH < vh - 16) {
    return { top: box.top + box.height + GAP, left: clampLeft(box.left), width: w }
  }
  return { top: clampTop(box.top - GAP - cardH), left: clampLeft(box.left), width: w }
}

/* ---------- 本体 ---------- */

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [inMenu, setInMenu] = useState(false)
  const [cardH, setCardH] = useState(160)
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
    // scroll: ステップの始めだけ、指し示す先が画面の中央に来るよう動かす（その後は位置を測り直すだけ）
    const measure = (scroll: boolean) => {
      const found = findVisible(step.targets)
      if (!found && tries++ < 10) {
        timer = window.setTimeout(() => measure(scroll), 100)
        return
      }
      if (!found) {
        setBox(null)
        setInMenu(false)
        return
      }
      if (scroll) {
        // 指し示す先が画面に収まっていない、または説明の枠と重なってしまうときだけ、
        // 上端（狭い画面の固定ヘッダーの下）に寄せる。下に説明の枠を置く余地ができる
        const r0 = found.el.getBoundingClientRect()
        const b0 = { top: r0.top - PAD, left: r0.left - PAD, width: r0.width + PAD * 2, height: r0.height + PAD * 2 }
        const c0 = placeCard(b0, cardHRef.current)
        const overlaps =
          c0.top < b0.top + b0.height && c0.top + cardHRef.current > b0.top && c0.left < b0.left + b0.width && c0.left + c0.width > b0.left
        const visible = r0.top >= 0 && r0.bottom <= window.innerHeight
        if (!visible || overlaps) window.scrollBy({ top: r0.top - HEADER_ROOM, behavior: 'instant' as ScrollBehavior })
      }
      const r = found.el.getBoundingClientRect()
      setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
      setInMenu(found.name === 'menu')
    }
    measure(true)
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
  }, [open, step])

  // 説明の枠の高さに合わせて置き場所を決め直す
  useLayoutEffect(() => {
    if (open && cardRef.current) {
      cardHRef.current = cardRef.current.offsetHeight
      setCardH(cardRef.current.offsetHeight)
    }
  }, [open, i, box, inMenu])

  useEffect(() => {
    if (!open) return
    primaryRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, i, close])

  if (!open) return null

  const last = i === STEPS.length - 1
  const pos = placeCard(box, cardH)

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
          className="pointer-events-none absolute rounded-lg ring-4 ring-white/90 transition-all duration-200"
          style={{ ...box, boxShadow: '0 0 0 9999px rgba(17, 24, 39, 0.55)' }}
        />
      ) : (
        <div key="dim" aria-hidden className="pointer-events-none absolute inset-0 bg-black/55" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className="absolute rounded-xl bg-rd-card p-5 shadow-2xl"
        style={{ top: pos.top, left: pos.left, width: pos.width }}
      >
        <p className="text-[0.86rem] font-bold text-rd-primary-text">
          使い方 {i + 1} / {STEPS.length}
        </p>
        <h2 id="tour-title" className="mt-1 text-[1.15rem] font-bold">
          {step.title}
        </h2>
        <p className="mt-1.5 text-[0.97rem] leading-relaxed">
          {step.body}
          {inMenu && step.whenInMenu && (
            <span className="mt-1 flex items-center gap-1 font-bold">
              <Icon name="menu" size={17} />
              {step.whenInMenu}
            </span>
          )}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            終わる
          </Button>
          <span className="flex-1" />
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
      if (e.key === 'Escape') onLaterRef.current()
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
        className="relative w-full max-w-sm rounded-xl bg-rd-card p-6 text-center shadow-2xl"
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
