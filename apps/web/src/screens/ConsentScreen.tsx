import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAgreeConsents, useConsents } from '@/lib/api/queries'
import type { ConsentDocument } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { Badge, Button, ErrorState, LinkButton, Loading, Modal, Notice } from '@/kit/kit'
import { LEGAL_DOCS, legalDocId } from '@/lib/legalDocs'
import { LegalBody } from './parts/LegalBody'
import { Centered, Logo } from './parts/EntryLayout'

/**
 * 同意の取得（企画書セクション5「利用目的の明示・同意取得」）。
 *
 * 外部AI事業者への提供、とくに外国にある第三者への提供は、
 * 利用規約への一括同意では足りないおそれがあるため、項目ごとに分けて取る（個人情報保護法28条）。
 * どの版に同意したかはサーバー側で記録する。
 *
 * この画面には2通りの来かたがある。
 *  - はじめて使うとき（必須の同意が済んでいない）→ 同意したらケースの画面へ
 *  - 使っている途中で「内容を見て同意する」を押したとき → 同意したら元の画面へ戻す
 *
 * 「全文を読む」は画面を移らず、ダイアログで開く。規約の画面へ移ると、この画面の状態
 * （付けたチェック）が消えてしまうため。
 */
export function ConsentScreen() {
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  const { data, isLoading, isError, refetch } = useConsents()
  const agree = useAgreeConsents()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [reading, setReading] = useState<ConsentDocument | null>(null)

  if (isLoading) return <Loading label="確認事項を読み込み中" />
  if (isError || !data)
    return <ErrorState message="確認事項を読み込めませんでした。" onRetry={() => void refetch()} />

  const pending = data.documents.filter((d) => d.agreedVersion !== d.version)
  const requiredPending = pending.filter((d) => d.required)
  const allRequiredChecked = requiredPending.every((d) => checked[d.kind])
  const anyChecked = pending.some((d) => checked[d.kind])
  // 任意の同意だけが残っている場合、何もチェックせずに「同意して進む」は押せないようにする
  const canAgree = allRequiredChecked && (requiredPending.length > 0 || anyChecked)
  const back = from ?? '/cases'

  // 同意が済んでいるなら、この画面に留まる理由がない
  if (pending.length === 0) {
    return (
      <Centered wide="doc">
        <Logo />
        <div className="mt-8 flex flex-col items-start gap-3 rounded-lg border border-rd-border bg-rd-card p-6">
          <p className="flex items-center gap-2 text-[1rem] font-bold">
            <Icon name="check-circle" size={20} className="text-rd-success-text" />
            確認事項には、すべて同意いただいています
          </p>
          <LinkButton to={back} variant="primary">
            手続きの画面へ進む
          </LinkButton>
        </div>
      </Centered>
    )
  }

  return (
    <Centered wide="doc">
      <Logo />
      <header className="mt-8">
        <p className="text-[0.9rem] font-bold text-rd-text-2">ご利用の前に</p>
        <h1 className="mt-0.5 text-[1.35rem] font-bold">確認のお願い</h1>
        <p className="mt-1 text-[0.94rem] leading-relaxed text-rd-text-2">
          {requiredPending.length > 0
            ? '次の内容をご確認のうえ、同意をお願いします。「必須」の項目に同意すると使いはじめられます。'
            : '次の内容をご確認ください。同意するかどうかは自由に選べます。'}
        </p>
      </header>

      <div className="mt-5 flex flex-col gap-4">
        <Notice tone="warning" title="この文面は確定していません">
          本文は仮置きです。弁護士の確認を経て差し替えます。
        </Notice>

        {pending.map((doc) => (
          <ConsentItem
            key={doc.kind}
            doc={doc}
            checked={Boolean(checked[doc.kind])}
            onChange={(v) => setChecked((prev) => ({ ...prev, [doc.kind]: v }))}
            onRead={() => setReading(doc)}
          />
        ))}
        <FullTextDialog doc={reading} onClose={() => setReading(null)} />

        {agree.isError && (
          <Notice tone="danger" role="alert">
            同意を記録できませんでした。時間をおいて、もう一度お試しください。
          </Notice>
        )}

        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            disabled={!canAgree || agree.isPending}
            onClick={async () => {
              await agree.mutateAsync(
                pending.filter((d) => checked[d.kind]).map((d) => ({ kind: d.kind, version: d.version })),
              )
              navigate(back, { replace: true })
            }}
          >
            {agree.isPending ? '記録しています…' : '同意して進む'}
          </Button>
          {requiredPending.length === 0 ? (
            // 任意の同意だけのとき（途中から来たとき）は、同意しないで戻る道も用意する
            <Button size="lg" onClick={() => navigate(back, { replace: true })}>
              同意せずに戻る
            </Button>
          ) : (
            !allRequiredChecked && (
              <p className="text-center text-[0.9rem] text-rd-text-2">
                「必須」の項目すべてにチェックを入れると進めます。
              </p>
            )
          )}
        </div>
      </div>
    </Centered>
  )
}

function ConsentItem({
  doc,
  checked,
  onChange,
  onRead,
}: {
  doc: ConsentDocument
  checked: boolean
  onChange: (v: boolean) => void
  onRead: () => void
}) {
  return (
    <section
      className={`rounded-lg border bg-rd-card ${checked ? 'border-rd-primary-line' : 'border-rd-border'}`}
      aria-label={doc.title}
    >
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[1.02rem] font-bold">{doc.title}</h2>
          {doc.required ? <Badge tone="red">必須</Badge> : <Badge>任意</Badge>}
          <span className="text-[0.86rem] text-rd-text-3">第{doc.version}版</span>
        </div>

        <ul className="mt-2.5 flex flex-col gap-1.5">
          {doc.summary.map((line, i) => (
            <li key={i} className="flex gap-2 text-[0.94rem] leading-relaxed">
              <Icon name="check" size={16} className="mt-1 shrink-0 text-rd-primary-text" />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onRead}
          aria-haspopup="dialog"
          className="mt-2.5 inline-flex cursor-pointer items-center gap-0.5 text-[0.9rem] font-bold text-rd-primary-text hover:underline"
        >
          全文を読む
          <Icon name="chevron-right" size={15} />
        </button>
      </div>

      <label className="flex cursor-pointer items-start gap-3 border-t border-rd-border bg-rd-bg px-4 py-3.5 sm:px-5">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0 accent-rd-primary"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-[0.97rem] leading-relaxed">
          <span className="font-bold">{doc.title}に同意します</span>
          {!doc.required && (
            <span className="mt-0.5 block text-[0.86rem] text-rd-text-2">
              同意しなくても、手続きと期限の管理は使えます。書類の読み取り・AIへの相談・窓口の自動調査は、同意したときだけ使えます。
            </span>
          )}
        </span>
      </label>
    </section>
  )
}

/** 全文。本文が画面側に無い文書（新しく増えたものなど）は、規約の画面を別のタブで開く道だけ出す */
function FullTextDialog({ doc, onClose }: { doc: ConsentDocument | null; onClose: () => void }) {
  const id = doc ? legalDocId(doc.url) : null
  const body = id ? LEGAL_DOCS[id] : null
  return (
    <Modal open={doc != null} title={doc?.title ?? ''} description={doc && `第${doc.version}版`} onClose={onClose} wide>
      {body ? (
        <LegalBody doc={body} bordered={false} />
      ) : (
        doc && (
          <p className="text-[0.94rem] leading-relaxed">
            この文書の全文は、
            <Link to={doc.url} target="_blank" rel="noreferrer" className="font-bold text-rd-primary-text underline">
              別のタブ
            </Link>
            で開いてご確認ください。
          </p>
        )
      )}
    </Modal>
  )
}
