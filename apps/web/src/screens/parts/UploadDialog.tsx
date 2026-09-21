import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DocumentKind } from '@aftercare/public-contracts'
import { ApiError } from '@/lib/api/client'
import { useUploadDocument } from '@/lib/api/queries'
import { Icon } from '@/kit/Icon'
import { formatFileSize } from '@/lib/format'
import { DOCUMENT_KIND_LABEL } from '@/lib/labels'
import { Button, Field, Modal, Notice, inputClass } from '@/kit/kit'
import { AiConsentNotice, useAiConsent } from '@/kit/domain'

type Phase = 'idle' | 'uploading' | 'checking' | 'done' | 'error'

// 拡張子だけだと端末によって写真が選べないことがあるため、種類（MIME）も並べる
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic,.pdf,.jpg,.jpeg,.png,.heic'

/**
 * 書類を追加。
 *
 * 利用場面：手元に死亡診断書・通帳・保険証券がある。スマホで撮るか、スキャンしたPDFを上げる。
 * 利用者にとっての関心は「上げたあと何が起きるか」なので、完了時にそれを一文で伝える。
 * マイナンバー検知の結果は、サーバーの判定をそのまま文言にする。
 */
export function Dropzone({
  caseId,
  onDone,
  onBusyChange,
}: {
  caseId: string
  onDone?: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const consent = useAiConsent()
  if (!consent.allowed) {
    // 追加した書類はAIが読み取る前提なので、同意が無い間は受け付けない
    return consent.loading ? null : <AiConsentNotice feature="書類の読み取り" />
  }
  return <DropzoneBody caseId={caseId} onDone={onDone} onBusyChange={onBusyChange} />
}

type Item = { key: number; name: string; size: number; phase: Exclude<Phase, 'idle'>; message?: string }

function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'PAYLOAD_TOO_LARGE')
    return 'ファイルが大きすぎて送れませんでした。写真の場合は、画質を下げて撮り直すか、1ページずつ追加してください。'
  if (err instanceof ApiError && err.code === 'UNSUPPORTED_MEDIA_TYPE')
    return 'この形式には対応していません。PDF・JPEG・PNG のいずれかでお試しください。'
  return 'うまく送れませんでした。通信の状態をご確認のうえ、もう一度お試しください。'
}

/**
 * 戸籍は何通にもなり、通帳も数ページある。まとめて選べるようにし、1枚ずつ順に送る。
 * 1枚が失敗しても残りは送り、どれが失敗したかを行ごとに示す。
 */
function DropzoneBody({
  caseId,
  onDone,
  onBusyChange,
}: {
  caseId: string
  onDone?: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const upload = useUploadDocument(caseId)
  const [kind, setKind] = useState<DocumentKind>('OTHER')
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  // 送信中にもう一度選んだりドロップしたりしても、二重に走らせない
  const running = useRef(false)
  const seq = useRef(0)
  const busy = items.some((i) => i.phase === 'uploading' || i.phase === 'checking')

  const patch = (key: number, p: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)))

  async function handle(files: FileList | null) {
    const list = Array.from(files ?? [])
    if (list.length === 0 || running.current) return
    running.current = true
    onBusyChange?.(true)
    const added: Item[] = list.map((f) => ({ key: ++seq.current, name: f.name, size: f.size, phase: 'uploading' }))
    setItems((prev) => [...prev, ...added])
    let anyDone = false

    for (let n = 0; n < list.length; n++) {
      const key = added[n].key
      // 送信後にサーバーで検査が走るので「確認中」を挟む
      const t = setTimeout(() => patch(key, { phase: 'checking' }), 500)
      try {
        const doc = await upload.mutateAsync({ file: list[n], kind })
        if (doc.inspection.status === 'REJECTED' || doc.storageState === 'FAILED') {
          const findings = doc.inspection.findings.map((f) => f.message)
          patch(key, { phase: 'error', message: findings.length > 0 ? findings.join('。') : 'お預かりできませんでした。' })
        } else {
          patch(key, { phase: 'done' })
          anyDone = true
        }
      } catch (err) {
        patch(key, { phase: 'error', message: errorMessage(err) })
      } finally {
        clearTimeout(t)
      }
    }
    if (inputRef.current) inputRef.current.value = ''
    if (cameraRef.current) cameraRef.current.value = ''
    running.current = false
    onBusyChange?.(false)
    if (anyDone) onDone?.()
  }

  const doneCount = items.filter((i) => i.phase === 'done').length

  return (
    <div className="flex flex-col gap-3">
      <Field label="書類の種類">
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
          >
            {Object.entries(DOCUMENT_KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handle(e.dataTransfer.files)
        }}
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center ${
          dragging ? 'border-rd-primary bg-rd-primary-soft' : 'border-rd-border bg-rd-bg'
        }`}
      >
        <Icon name="upload" size={28} className="text-rd-text-3" />
        {/* スマホではドラッグできないので、その案内は広い画面でだけ出す */}
        <p className="hidden text-[0.97rem] font-bold sm:block">ここにファイルをドラッグ</p>
        <p className="text-[0.86rem] text-rd-text-2">何枚でもまとめて選べます。スマホで撮った写真やPDFをそのまま追加できます</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          onChange={(e) => void handle(e.target.files)}
        />
        {/* スマホでは、その場で書類を撮るのがいちばん早い */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          onChange={(e) => void handle(e.target.files)}
        />
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon="upload" disabled={busy} onClick={() => inputRef.current?.click()}>
            ファイルを選ぶ
          </Button>
          <Button className="sm:hidden" disabled={busy} onClick={() => cameraRef.current?.click()}>
            カメラで撮る
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="rounded-lg border border-rd-border px-3 py-2.5">
              <div className="flex items-center gap-3">
                <Icon name="document" size={20} className="text-rd-text-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.94rem] font-bold">{i.name}</span>
                  <span className="block text-[0.82rem] text-rd-text-3">{formatFileSize(i.size)}</span>
                </span>
                <span className="shrink-0 text-[0.86rem] font-bold">
                  {i.phase === 'uploading' && <span className="text-rd-primary-text">送信中…</span>}
                  {i.phase === 'checking' && <span className="text-rd-primary-text">確認中…</span>}
                  {i.phase === 'done' && <span className="text-rd-success-text">追加しました</span>}
                  {i.phase === 'error' && <span className="text-rd-danger-text">できませんでした</span>}
                </span>
              </div>
              {i.message && (
                <p className={`mt-1 text-[0.86rem] ${i.phase === 'error' ? 'text-rd-danger-text' : 'text-rd-text-2'}`}>{i.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {doneCount > 0 && !busy && (
        <Notice tone="success" title={`${doneCount}件追加しました`}>
          書類の詳細から「読み取りを依頼する」と、AIが内容を読み取ります。進み具合は「書類」で確かめられます。
        </Notice>
      )}

      <p className="text-[0.82rem] leading-relaxed text-rd-text-3">
        マイナンバーが書かれた書類（マイナンバーカードの写し・源泉徴収票など）は追加できません。
      </p>
    </div>
  )
}

export function UploadDialog({
  caseId,
  open,
  onClose,
}: {
  caseId: string
  open: boolean
  onClose: () => void
}) {
  const [done, setDone] = useState(false)
  // 送信中に閉じると、どこまで送れたかが分からなくなる。送り終わるまで閉じさせない
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (busy) return
    setDone(false)
    onClose()
  }
  return (
    <Modal
      open={open}
      title="書類を追加"
      description="死亡診断書・戸籍・通帳・保険証券・遺言書など。書類の種類を選んでから追加してください。"
      onClose={close}
      footer={
        busy ? (
          <Button disabled>送信中です…</Button>
        ) : done ? (
          <>
            <Button onClick={close}>閉じる</Button>
            <Link
              to={`/cases/${caseId}/documents`}
              onClick={close}
              className="inline-flex h-11 items-center rounded-md bg-rd-primary px-4 text-[0.97rem] font-bold text-white"
            >
              読み取りの進み具合を見る
            </Link>
          </>
        ) : (
          <Button onClick={close}>閉じる</Button>
        )
      }
    >
      {/* 開き直すたびに初期状態から始める */}
      {open && <Dropzone caseId={caseId} onDone={() => setDone(true)} onBusyChange={setBusy} />}
    </Modal>
  )
}
