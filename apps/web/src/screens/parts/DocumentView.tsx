import { useEffect, useState } from 'react'
import { useDocumentContent } from '@/lib/api/queries'
import { ApiError } from '@/lib/api/client'
import { Icon } from '@/kit/Icon'
import { Button } from '@/kit/kit'

type Kind = 'image' | 'pdf' | 'unsupported'

/**
 * 原本の種類を見分ける。
 * Backend は application/octet-stream で返すため、Content-Type だけでは決められない。
 * 先頭のバイト（PDF・PNG・JPEG の印）を見て、無理ならファイル名の拡張子で判断する。
 */
interface Detected {
  kind: Kind
  /**
   * 表示に使う MIME タイプ。サーバーが付けてきた種類は使わず、中身から決めたものに付け直す。
   * text/html などのまま Blob URL を新しいタブで開くと、アプリと同じオリジンでスクリプトが動いてしまうため。
   */
  type: string
}

/**
 * 先頭のバイト（PDF・PNG・JPEG の印）だけで判断する。拡張子や Content-Type は信用しない
 * （中身が HTML の「.pdf」を PDF として開かせないため）。
 */
async function detectKind(blob: Blob): Promise<Detected> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const text = String.fromCharCode(...head)
  if (text.startsWith('%PDF')) return { kind: 'pdf', type: 'application/pdf' }
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return { kind: 'image', type: 'image/png' }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', type: 'image/jpeg' }
  // モックの見本の紙面（SVG）。<img> で出す分にはスクリプトは動かないが、新しいタブでは開かせない
  if (blob.type === 'image/svg+xml') return { kind: 'image', type: 'image/svg+xml' }
  // HEIC（iPhone の写真）など、ブラウザで表示できないもの
  return { kind: 'unsupported', type: 'application/octet-stream' }
}

/**
 * 書類の原本を表示する。
 *
 * - 画像／PDF：ブラウザの表示に任せる。
 * - 表示できない形式（HEIC など）：保存して開けるようにする。
 *
 * 取り出したデータ（Blob URL）は、画面を離れるときに必ず破棄する。
 */
export function DocumentView({
  caseId,
  documentId,
  fileName,
  heightClass = 'h-72 sm:h-96',
}: {
  caseId: string
  documentId: string
  fileName: string
  /** 表示枠の高さ。長い書類は枠の中でスクロールする */
  heightClass?: string
}) {
  const content = useDocumentContent(caseId, documentId)
  const [view, setView] = useState<{ url: string; kind: Kind; openable: boolean } | null>(null)

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

  const frame = `relative overflow-auto rounded-md border border-rd-border-2 bg-rd-shade ${heightClass}`

  if (content.isError) {
    const notFound = content.error instanceof ApiError && (content.error.status === 404 || content.error.status === 409)
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
        {view.openable && (
          <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
            大きく表示する
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className={frame}>
        <img src={view.url} alt={`元の書類：${fileName}`} className="block w-full" />
      </div>
      {view.openable && (
        <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
          大きく表示する
        </a>
      )}
    </div>
  )
}
