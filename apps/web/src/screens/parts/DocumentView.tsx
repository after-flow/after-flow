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
async function detectKind(blob: Blob, fileName: string): Promise<Kind> {
  if (blob.type === 'application/pdf') return 'pdf'
  if (/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(blob.type)) return 'image'
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const text = String.fromCharCode(...head)
  if (text.startsWith('%PDF')) return 'pdf'
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return 'image'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image'
  // HEIC（iPhone の写真）はブラウザで表示できないことが多い
  if (text.slice(4, 8) === 'ftyp') return 'unsupported'
  if (/\.pdf$/i.test(fileName)) return 'pdf'
  if (/\.(png|jpe?g)$/i.test(fileName)) return 'image'
  return 'unsupported'
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
  const [view, setView] = useState<{ url: string; kind: Kind } | null>(null)

  useEffect(() => {
    const blob = content.data
    if (!blob) return
    let cancelled = false
    const url = URL.createObjectURL(blob)
    void detectKind(blob, fileName).then((kind) => {
      if (!cancelled) setView({ url, kind })
    })
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
      setView(null)
    }
  }, [content.data, fileName])

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
        <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
          大きく表示する
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className={frame}>
        <img src={view.url} alt={`元の書類：${fileName}`} className="block w-full" />
      </div>
      <a href={view.url} target="_blank" rel="noreferrer" className="self-end text-[0.86rem] font-bold text-rd-primary-text hover:underline">
        大きく表示する
      </a>
    </div>
  )
}
