import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAgreeConsents, useConsents } from '@/api/queries'
import { Button, Card, ErrorState, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { Icon } from '@/components/ui/Icon'
import type { ConsentDocument } from '@/api/types'

/**
 * 同意の取得（企画書セクション5「利用目的の明示・同意取得」）。
 *
 * 外部AI事業者への提供、とくに外国にある第三者への提供は、
 * 利用規約への一括同意では足りないおそれがあるため、項目ごとに分けて取る。
 * どの版に同意したかはサーバー側で記録する。
 */
export function ConsentPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, refetch } = useConsents()
  const agree = useAgreeConsents()
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  if (isLoading) return <Spinner label="確認事項を読み込み中" />
  if (isError || !data)
    return (
      <div className="mx-auto max-w-2xl p-4 py-6">
        <ErrorState message="確認事項を取得できませんでした。" onRetry={() => void refetch()} />
      </div>
    )

  const pending = data.documents.filter((d) => d.agreedVersion !== d.version)
  const requiredPending = pending.filter((d) => d.required)
  const allRequiredChecked = requiredPending.every((d) => checked[d.kind])

  // 同意が済んでいるなら、この画面に留まる理由がない
  if (pending.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-4 py-6">
        <Card>
          <p className="font-bold">確認事項はすべてご同意いただいています。</p>
          <Link className="btn btn-primary mt-3" to="/cases">
            ケース一覧へ進む
          </Link>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl p-4 py-6">
      <header className="mb-5">
        <p className="eyebrow">ご利用の前に</p>
        <h1 className="mt-0.5 text-[1.55rem] font-bold">確認のお願い</h1>
        <p className="mt-1 text-[var(--color-ink-muted)]">
          ご利用にあたり、次の内容をご確認のうえ、同意をお願いします。
        </p>
      </header>

      <Banner tone="warning" title="この文面は確定していません">
        本文は仮置きです。弁護士の確認を経て差し替えます。
      </Banner>

      <div className="mt-4 flex flex-col gap-3">
        {pending.map((doc) => (
          <ConsentItem
            key={doc.kind}
            doc={doc}
            checked={Boolean(checked[doc.kind])}
            onChange={(v) => setChecked((prev) => ({ ...prev, [doc.kind]: v }))}
          />
        ))}
      </div>

      {agree.isError && (
        <div className="mt-4">
          <Banner tone="critical" role="alert">
            同意を記録できませんでした。時間をおいて、もう一度お試しください。
          </Banner>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2">
        <Button
          variant="primary"
          disabled={!allRequiredChecked || agree.isPending}
          onClick={async () => {
            await agree.mutateAsync(
              pending
                .filter((d) => checked[d.kind])
                .map((d) => ({ kind: d.kind, version: d.version })),
            )
            navigate('/cases', { replace: true })
          }}
        >
          {agree.isPending ? '記録しています…' : '同意して進む'}
        </Button>
        {!allRequiredChecked && (
          <p className="text-sm text-[var(--color-ink-muted)]">
            必須の項目すべてにチェックを入れると進めます。
          </p>
        )}
      </div>
    </div>
  )
}

function ConsentItem({
  doc,
  checked,
  onChange,
}: {
  doc: ConsentDocument
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <section
      className="card p-4"
      style={{ borderLeft: `5px solid ${doc.required ? 'var(--color-brand)' : 'var(--color-line-strong)'}` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="section-title">{doc.title}</h2>
        {doc.required ? (
          <span className="badge badge-red">必須</span>
        ) : (
          <span className="badge badge-gray">任意</span>
        )}
        <span className="text-sm text-[var(--color-ink-faint)]">第{doc.version}版</span>
      </div>

      <ul className="mt-2 flex flex-col gap-1.5">
        {doc.summary.map((line, i) => (
          <li key={i} className="flex gap-2">
            <Icon name="check" size={16} className="mt-1.5 shrink-0 text-[var(--color-brand)]" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <Link
        className="mt-2 inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline"
        to={doc.url}
      >
        全文を読む
        <Icon name="chevron-right" size={15} />
      </Link>

      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-surface-sunken)] p-3">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-brand)]"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="font-bold">
          {doc.title}に同意します
          {!doc.required && (
            <span className="ml-1 font-normal text-[var(--color-ink-muted)]">
              （同意されない場合も、書類の解析以外の機能はご利用いただけます）
            </span>
          )}
        </span>
      </label>
    </section>
  )
}
