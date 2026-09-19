import { useRef, useState } from 'react'
import { useUploadDocument } from '@/api/queries'
import { HttpError } from '@/api/client'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Primitives'
import { formatFileSize } from '@/lib/format'
import { Icon } from '@/components/ui/Icon'

type Phase = 'idle' | 'uploading' | 'verifying' | 'done' | 'error'

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic'

/**
 * 書類アップローダ（仕様書セクション4）。
 * マイナンバー記載の検知・マスキング処理を挟むため、
 * 「アップロード中」→「確認中」→「保存完了」の3段階でステータスを表示する。
 */
export function DocumentUploader({ caseId }: { caseId: string }) {
  const upload = useUploadDocument(caseId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [current, setCurrent] = useState<{ name: string; size: number } | null>(null)

  async function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return

    setCurrent({ name: file.name, size: file.size })
    setMessage(null)
    setPhase('uploading')

    // 送信完了後にサーバ側でマイナンバー検知が走るため、UI上は「確認中」を挟む
    const toVerifying = setTimeout(() => setPhase('verifying'), 500)

    try {
      const doc = await upload.mutateAsync(file)
      clearTimeout(toVerifying)
      setPhase('done')
      setMessage(
        doc.myNumberScan === 'MASKED'
          ? 'マイナンバーらしき記載を検出したため、該当箇所を隠したうえで保存しました。'
          : '保存が完了しました。内容の解析を開始します。',
      )
    } catch (err) {
      clearTimeout(toVerifying)
      setPhase('error')
      if (err instanceof HttpError && err.body?.code === 'MY_NUMBER_DETECTED') {
        setMessage(
          'マイナンバーが記載された書類はアップロードできません。該当箇所を隠してから再度お試しください。',
        )
      } else if (err instanceof HttpError && err.body?.code === 'UNSUPPORTED_FILE_TYPE') {
        setMessage('この形式のファイルには対応していません。PDF・JPEG・PNG のいずれかをお試しください。')
      } else {
        setMessage('アップロードに失敗しました。通信環境をご確認のうえ、もう一度お試しください。')
      }
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const steps: { phase: Phase; label: string }[] = [
    { phase: 'uploading', label: 'アップロード中' },
    { phase: 'verifying', label: '確認中' },
    { phase: 'done', label: '保存完了' },
  ]
  const activeIndex = steps.findIndex((s) => s.phase === phase)

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handleFiles(e.dataTransfer.files)
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center ${
          dragging
            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
            : 'border-[var(--color-line)] bg-[var(--color-surface-sunken)]'
        }`}
      >
        <Icon name="upload" size={30} className="text-[var(--color-ink-faint)]" />
        <p className="font-bold">書類をここにドラッグ＆ドロップ</p>
        <p className="text-sm text-[var(--color-ink-muted)]">
          または、ファイルを選んでアップロードしてください（PDF・JPEG・PNG）
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="visually-hidden"
          id="document-file-input"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <Button variant="primary" onClick={() => inputRef.current?.click()}>
          ファイルを選ぶ
        </Button>
      </div>

      {phase !== 'idle' && current && (
        <div className="card p-4">
          <p className="font-bold">
            {current.name}
            <span className="ml-2 font-normal text-[var(--color-ink-faint)]">
              {formatFileSize(current.size)}
            </span>
          </p>
          {phase !== 'error' && (
            <ol className="mt-3 flex flex-wrap items-center gap-2" aria-live="polite">
              {steps.map((s, i) => {
                const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo'
                return (
                  <li key={s.phase} className="flex items-center gap-2">
                    <span
                      className={`badge ${
                        state === 'done' ? 'badge-green' : state === 'active' ? 'badge-blue' : 'badge-gray'
                      }`}
                    >
                      <Icon
                        name={state === 'done' ? 'check' : state === 'active' ? 'progress' : 'circle'}
                        size={14}
                      />
                      {s.label}
                    </span>
                    {i < steps.length - 1 && (
                      <span aria-hidden className="text-[var(--color-ink-faint)]">/</span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          {message && (
            <div className="mt-3">
              <Banner tone={phase === 'error' ? 'critical' : 'info'} role={phase === 'error' ? 'alert' : 'note'}>
                {message}
              </Banner>
            </div>
          )}
        </div>
      )}

      <Banner tone="info">
        マイナンバーが記載された書類（住民票の一部、源泉徴収票、マイナンバーカードの写しなど）はお預かりできません。アップロード時に検知した場合はお断りするか、該当箇所を隠して保存します。
      </Banner>
    </div>
  )
}
