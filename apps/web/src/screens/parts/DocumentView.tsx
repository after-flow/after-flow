import { useEffect, useRef, useState } from 'react'
import type { ProposalDiffRow } from '@aftercare/public-contracts'
import { useDocumentContent } from '@/lib/api/queries'
import { HttpError } from '@/lib/api/client'
import { Icon } from '@/kit/Icon'
import { Button } from '@/kit/kit'

type Kind = 'image' | 'pdf' | 'unsupported'

interface Detected {
  kind: Kind
  /**
   * 表示に使う MIME タイプ。サーバーが付けてきた種類は使わず、中身から決めたものに付け直す。
   * text/html などのまま Blob URL を新しいタブで開くと、アプリと同じオリジンでスクリプトが動いてしまうため。
   */
  type: string
}

/**
 * 原本の種類を見分ける。
 * Backend は application/octet-stream で返すため、Content-Type では決められない。
 * 先頭のバイト（PDF・PNG・JPEG の印）だけで判断する。拡張子や Content-Type は信用しない
 * （中身が HTML の「.pdf」を PDF として開かせないため）。
 */
async function detectKind(blob: Blob): Promise<Detected> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const text = String.fromCharCode(...head)
  if (text.startsWith('%PDF')) return { kind: 'pdf', type: 'application/pdf' }
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return { kind: 'image', type: 'image/png' }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', type: 'image/jpeg' }
  // モックの見本の紙面（SVG）。<img> で出す分にはスクリプトは動かないが、新しいタブでは開かせない
  if (blob.type === 'image/svg+xml') return { kind: 'image', type: 'image/svg+xml' }
  // HEIC（iPhone の写真）など、ブラウザで表示できないもの
  return { kind: 'unsupported', type: 'application/octet-stream' }
}

export interface SourceBoxRow {
  field: string
  box: NonNullable<ProposalDiffRow['sourceBox']>
}

/**
 * 書類の原本を表示する。
 *
 * - 画像：読み取った位置（sourceBox）に枠を重ねる。枠は画像に対する割合なので、画像と一緒に伸び縮みする。
 * - PDF：ブラウザの表示に任せる。ページ内の位置が分からないため枠は出さない。
 * - 表示できない形式（HEIC など）：保存して開けるようにする。
 *
 * 取り出したデータ（Blob URL）は、画面を離れるときに必ず破棄する。
 */
export function DocumentView({
  caseId,
  documentId,
  fileName,
  boxes = [],
  picked = null,
  heightClass = 'h-72 sm:h-96',
}: {
  caseId: string
  documentId: string
  fileName: string
  boxes?: SourceBoxRow[]
  picked?: string | null
  /** 表示枠の高さ。長い書類は枠の中でスクロールする */
  heightClass?: string
}) {
  const content = useDocumentContent(caseId, documentId)
  const [view, setView] = useState<{ url: string; kind: Kind; openable: boolean } | null>(null)
  const activeRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const blob = content.data
    if (!blob) return
    let cancelled = false
    let url: string | null = null
    void detectKind(blob).then(({ kind, type }) => {
      if (cancelled) return
      url = URL.createObjectURL(new Blob([blob], { type }))
      setView({ url, kind, openable: type !== 'image/svg+xml' })
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      setView(null)
    }
  }, [content.data])

  /*
    項目を選んだら、その枠が見える位置まで「表示枠の中だけ」をスクロールする。
    scrollIntoView はページ全体も動かすため、スマートフォンで入力中の欄が画面から消えてしまう。
  */
  useEffect(() => {
    const frame = frameRef.current
    const box = activeRef.current
    if (!frame || !box) return
    const top = box.offsetTop
    const bottom = top + box.offsetHeight
    if (top < frame.scrollTop || bottom > frame.scrollTop + frame.clientHeight) {
      frame.scrollTo({ top: Math.max(0, top - 32), behavior: 'smooth' })
    }
  }, [picked, view])

  const frame = `relative overflow-auto rounded-md border border-rd-border-2 bg-rd-shade ${heightClass}`

  if (content.isError) {
    const notFound = content.error instanceof HttpError && (content.error.status === 404 || content.error.status === 409)
    return (
      <div className={`${frame} flex flex-col items-center justify-center gap-2 px-6 text-center`}>
        <Icon name="document" size={26} className="text-rd-text-3" />
        <p className="text-[0.94rem] font-bold">{notFound ? '元の書類を表示できません' : '元の書類を読み込めませんでした'}</p>
        <p className="text-[0.86rem] text-rd-text-2">
          {notFound ? '保存が終わっていないか、削除された可能性があります。' : '通信の状態を確かめて、もう一度お試しください。'}
        </p>
        {!notFound && (
          <Button size="sm" onClick={() => void content.refetch()}>
            もう一度読み込む
          </Button>
        )}
      </div>
    )
  }

  if (!view) {
    return (
      <div className={`${frame} grid place-items-center`} aria-busy>
        <p className="text-[0.9rem] text-rd-text-2">元の書類を読み込んでいます…</p>
      </div>
    )
  }

  if (view.kind === 'unsupported') {
    return (
      <div className={`${frame} flex flex-col items-center justify-center gap-2 px-6 text-center`}>
        <Icon name="document" size={26} className="text-rd-text-3" />
        <p className="text-[0.94rem] font-bold">この形式はブラウザで表示できません</p>
        <p className="text-[0.86rem] text-rd-text-2">保存してから、端末の写真アプリなどで開いてください。</p>
        <a href={view.url} download={fileName} className="text-[0.9rem] font-bold text-rd-primary-text underline">
          書類を保存する
        </a>
      </div>
    )
  }

  if (view.kind === 'pdf') {
    return (
      <div className="flex flex-col gap-1.5">
        <iframe title={`元の書類：${fileName}`} src={view.url} className={`w-full rounded-md border border-rd-border-2 bg-rd-shade ${heightClass}`} />
        <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
          大きく表示する
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={frameRef} className={frame}>
        <div className="relative">
          <img src={view.url} alt={`元の書類：${fileName}`} className="block w-full" />
          {boxes.map(({ field, box }) => {
            const on = picked === field
            return (
              <span
                key={field}
                ref={on ? activeRef : undefined}
                className={`absolute rounded border-2 transition-colors ${on ? 'border-rd-primary bg-rd-primary/15' : 'border-rd-primary-line bg-rd-primary/5'}`}
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
              >
                {on && (
                  <span className={`absolute ${box.y < 0.06 ? 'top-full mt-0.5' : '-top-5'} -left-0.5 rounded bg-rd-primary px-1.5 text-[0.8rem] font-bold leading-[18px] whitespace-nowrap text-white`}>
                    {field}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      </div>
      {view.openable && (
        <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
          大きく表示する
        </a>
      )}
    </div>
  )
}
