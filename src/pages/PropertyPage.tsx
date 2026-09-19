import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  useAssets,
  useBenefits,
  useContracts,
  useCreateAsset,
  useCreateContract,
  useCreateLiability,
  useLiabilities,
  useUpdateAsset,
  useUpdateBenefit,
  useUpdateContract,
  useUpdateLiability,
} from '@/api/queries'
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  SelectInput,
  Spinner,
  TextInput,
} from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { Modal } from '@/components/ui/Modal'
import { Term } from '@/components/ui/Term'
import { ItemRow, itemIcon } from '@/components/domain/ItemRow'
import { PropertyBalance } from '@/components/domain/PropertyBalance'
import { DeadlineChip } from '@/components/domain/StatusBadges'
import { LockedActionNotice, useRenunciationLock } from '@/components/domain/RenunciationLock'
import {
  ASSET_KIND_LABEL,
  BENEFIT_KIND_LABEL,
  CONTRACT_KIND_LABEL,
  CONTRACT_POLICY_LABEL,
  CONTRACT_PROGRESS_META,
  LIABILITY_KIND_LABEL,
} from '@/lib/labels'
import { formatYen } from '@/lib/format'
import { Icon } from '@/components/ui/Icon'
import type { Asset, ContractPolicy, ContractProgress, Liability } from '@/api/types'

const TABS = [
  { id: 'assets', label: '財産' },
  { id: 'liabilities', label: '債務' },
  { id: 'contracts', label: '契約' },
  { id: 'benefits', label: '保険金・年金' },
] as const

export function PropertyPage() {
  const { caseId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') ?? 'assets') as (typeof TABS)[number]['id']
  const { locked } = useRenunciationLock(caseId)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="財産・契約"
        title="財産・債務・契約"
        description="書類から見つかったものと、ご自身で追加したものをまとめています。"
      />

      {locked && <LockedActionNotice caseId={caseId} />}

      <div role="tablist" aria-label="表示の切り替え" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setParams({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'assets' && <AssetsTab caseId={caseId} />}
      {tab === 'liabilities' && <LiabilitiesTab caseId={caseId} />}
      {tab === 'contracts' && <ContractsTab caseId={caseId} locked={locked} />}
      {tab === 'benefits' && <BenefitsTab caseId={caseId} />}
    </div>
  )
}

/* ---------- 財産 ---------- */

function AssetsTab({ caseId }: { caseId: string }) {
  const { data, isLoading } = useAssets(caseId)
  const liabilities = useLiabilities(caseId)
  const update = useUpdateAsset(caseId)
  const create = useCreateAsset(caseId)
  const [showNew, setShowNew] = useState(false)

  if (isLoading) return <Spinner />
  const items = data?.items ?? []

  return (
    <div className="flex flex-col gap-4">
      {(items.length > 0 || (liabilities.data?.items.length ?? 0) > 0) && (
        <PropertyBalance assets={items} liabilities={liabilities.data?.items} />
      )}

      <Card
        title="財産"
        action={
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={16} />
            追加する
          </Button>
        }
        bodyClassName="p-3 sm:p-4"
      >
        {items.length === 0 ? (
          <EmptyState
            title="まだ財産が登録されていません"
            description="書類をアップロードすると候補が表示されます。見つからないものは手動で追加してください。"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((a) => {
              const ic = itemIcon(a.kind)
              return (
                <li key={a.id}>
                  <ItemRow
                    icon={ic.icon}
                    iconFg={ic.fg}
                    iconBg={ic.bg}
                    title={a.name}
                    value={formatYen(a.amount)}
                    sub={a.institution}
                    badges={
                      <>
                        <span className="badge badge-gray">{ASSET_KIND_LABEL[a.kind]}</span>
                        <span className={`badge ${a.source === 'AI' ? 'badge-blue' : 'badge-gray'}`}>
                          {a.source === 'AI' ? 'AI検出' : '手動登録'}
                        </span>
                        <span
                          className={`badge ${a.confirmation === 'CONFIRMED' ? 'badge-green' : 'badge-yellow'}`}
                        >
                          {a.confirmation === 'CONFIRMED' ? '確認済み' : '未確認'}
                        </span>
                      </>
                    }
                  >
                    {a.taxAttention && (
                      <p className="flex gap-1.5 text-sm text-[var(--color-state-yellow)]">
                        <Icon name="warning" size={16} className="mt-1" />
                        <span>
                          税務上の判断が必要な場合があります（生前贈与・
                          <Term word="名義預金" />
                          など）。税理士へのご相談をご検討ください。
                        </span>
                      </p>
                    )}

                    {a.confirmation === 'UNCONFIRMED' && (
                      <div className="mt-2 rounded-lg bg-[var(--color-surface-sunken)] p-3">
                        {a.source === 'AI' && (
                          <p className="text-sm">
                            この情報は書類の解析結果です。内容をご確認のうえ確定してください。
                          </p>
                        )}
                        <Button
                          size="sm"
                          variant={a.source === 'AI' ? 'primary' : 'secondary'}
                          className={a.source === 'AI' ? 'mt-2' : ''}
                          onClick={() =>
                            void update.mutateAsync({ id: a.id, confirmation: 'CONFIRMED' })
                          }
                        >
                          <Icon name="check" size={16} />
                          内容を確認しました
                        </Button>
                      </div>
                    )}
                  </ItemRow>
                </li>
              )
            })}
          </ul>
        )}

        <ItemModal
          open={showNew}
          title="財産を追加する"
          kinds={ASSET_KIND_LABEL}
          partyLabel="金融機関・所在など"
          onClose={() => setShowNew(false)}
          onSubmit={async (v) => {
            await create.mutateAsync({
              name: v.name,
              kind: v.kind as Asset['kind'],
              institution: v.party || undefined,
              amount: v.amount,
              source: 'MANUAL',
              confirmation: 'CONFIRMED',
            })
          }}
        />
      </Card>
    </div>
  )
}

/* ---------- 債務 ---------- */

function LiabilitiesTab({ caseId }: { caseId: string }) {
  const { data, isLoading } = useLiabilities(caseId)
  const assets = useAssets(caseId)
  const update = useUpdateLiability(caseId)
  const create = useCreateLiability(caseId)
  const [showNew, setShowNew] = useState(false)

  if (isLoading) return <Spinner />
  const items = data?.items ?? []

  return (
    <div className="flex flex-col gap-4">
      {(items.length > 0 || (assets.data?.items.length ?? 0) > 0) && (
        <PropertyBalance assets={assets.data?.items} liabilities={items} />
      )}

      <Card
        title="債務"
        action={
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={16} />
            追加する
          </Button>
        }
        bodyClassName="p-3 sm:p-4"
      >
        <Banner tone="info">
          借金の返済は、
          <Term word="相続放棄" />
          ができなくなる原因になることがあります。相続方法が決まるまでは、記録にとどめてください。
        </Banner>

        {items.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="まだ債務が登録されていません" />
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {items.map((l) => {
              const ic = itemIcon(l.kind)
              return (
                <li key={l.id}>
                  <ItemRow
                    icon={ic.icon}
                    iconFg={ic.fg}
                    iconBg={ic.bg}
                    title={l.name}
                    value={formatYen(l.amount)}
                    sub={l.creditor}
                    badges={
                      <>
                        <span className="badge badge-gray">{LIABILITY_KIND_LABEL[l.kind]}</span>
                        <span className={`badge ${l.source === 'AI' ? 'badge-blue' : 'badge-gray'}`}>
                          {l.source === 'AI' ? 'AI検出' : '手動登録'}
                        </span>
                        <span
                          className={`badge ${l.confirmation === 'CONFIRMED' ? 'badge-green' : 'badge-yellow'}`}
                        >
                          {l.confirmation === 'CONFIRMED' ? '確認済み' : '未確認'}
                        </span>
                      </>
                    }
                  >
                    {l.confirmation === 'UNCONFIRMED' && (
                      <Button
                        size="sm"
                        onClick={() => void update.mutateAsync({ id: l.id, confirmation: 'CONFIRMED' })}
                      >
                        <Icon name="check" size={16} />
                        内容を確認しました
                      </Button>
                    )}
                  </ItemRow>
                </li>
              )
            })}
          </ul>
        )}

        <ItemModal
          open={showNew}
          title="債務を追加する"
          kinds={LIABILITY_KIND_LABEL}
          partyLabel="借入先・請求元"
          onClose={() => setShowNew(false)}
          onSubmit={async (v) => {
            await create.mutateAsync({
              name: v.name,
              kind: v.kind as Liability['kind'],
              creditor: v.party || undefined,
              amount: v.amount,
              source: 'MANUAL',
              confirmation: 'CONFIRMED',
            })
          }}
        />
      </Card>
    </div>
  )
}

/* ---------- 契約 ---------- */

function ContractsTab({ caseId, locked }: { caseId: string; locked: boolean }) {
  const { data, isLoading } = useContracts(caseId)
  const update = useUpdateContract(caseId)
  const create = useCreateContract(caseId)
  const [showNew, setShowNew] = useState(false)

  if (isLoading) return <Spinner />
  const items = data?.items ?? []

  /*
    放棄前ロック中は「解約」「名義変更」を新たに選べないようにする。
    ただし選択肢ごと消すと、既にその方針が入っている契約で
    select の表示が保存値とずれ、「未選択」に見えてしまう。
    選択肢は残したまま disabled にして、表示は事実どおりに保つ。
  */
  const ALL_POLICIES: ContractPolicy[] = ['UNDECIDED', 'CONTINUE', 'TRANSFER', 'CANCEL']
  const LOCKED_POLICIES: ContractPolicy[] = ['TRANSFER', 'CANCEL']

  return (
    <Card
      title="契約"
      action={
        <Button size="sm" onClick={() => setShowNew(true)}>
          手動で追加する
        </Button>
      }
    >
      {items.length === 0 ? (
        <EmptyState title="まだ契約が登録されていません" />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-line)]">
          {items.map((c) => (
            <li key={c.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{c.name}</span>
                <span className="badge badge-gray">{CONTRACT_KIND_LABEL[c.kind]}</span>
                <span className={`badge ${CONTRACT_PROGRESS_META[c.progress].className}`}>
                  {CONTRACT_PROGRESS_META[c.progress].label}
                </span>
                <span className={`badge ${c.source === 'AI' ? 'badge-blue' : 'badge-gray'}`}>
                  {c.source === 'AI' ? 'AI検出' : '手動登録'}
                </span>
              </div>
              {c.provider && <p className="text-[var(--color-ink-muted)]">{c.provider}</p>}

              <div className="mt-2 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm font-bold">
                  対応方針
                  <select
                    className="select"
                    value={c.policy}
                    onChange={(e) =>
                      void update.mutateAsync({ id: c.id, policy: e.target.value as ContractPolicy })
                    }
                  >
                    {ALL_POLICIES.map((p) => (
                      <option
                        key={p}
                        value={p}
                        disabled={locked && LOCKED_POLICIES.includes(p)}
                      >
                        {CONTRACT_POLICY_LABEL[p]}
                        {locked && LOCKED_POLICIES.includes(p) ? '（相続方法の確定後）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm font-bold">
                  状態
                  <select
                    className="select"
                    value={c.progress}
                    onChange={(e) =>
                      void update.mutateAsync({
                        id: c.id,
                        progress: e.target.value as ContractProgress,
                      })
                    }
                  >
                    <option value="NOT_STARTED">未対応</option>
                    <option value="CONTACTED">連絡済み</option>
                    <option value="COMPLETED">完了</option>
                  </select>
                </label>
              </div>

              {locked && (
                <p className="mt-2 flex gap-1.5 text-sm text-[var(--color-state-yellow)]">
                  <Icon name="warning" size={16} className="mt-1" />
                  <span>
                    相続方法が確定するまで、「解約」「名義変更」は選べません。手順のご案内も表示していません。
                  </span>
                </p>
              )}

              {!locked && c.guidance && (
                <details className="mt-2 rounded-lg bg-[var(--color-surface-sunken)] p-3">
                  <summary className="cursor-pointer font-bold">手順と連絡先を見る</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {c.guidance.where && <p>連絡先：{c.guidance.where}</p>}
                    {(c.guidance.bring?.length ?? 0) > 0 && (
                      <div>
                        <p className="font-bold">必要なもの</p>
                        <ul className="list-disc pl-5">
                          {c.guidance.bring!.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="text-sm text-[var(--color-ink-muted)]">
                      お手続きはご本人からご連絡ください。本サービスから連絡・解約は行いません。
                    </p>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <ItemModal
        open={showNew}
        title="契約を追加する"
        kinds={CONTRACT_KIND_LABEL}
        partyLabel="契約先"
        withAmount={false}
        onClose={() => setShowNew(false)}
        onSubmit={async (v) => {
          await create.mutateAsync({
            name: v.name,
            kind: v.kind as never,
            provider: v.party || undefined,
            policy: 'UNDECIDED',
            progress: 'NOT_STARTED',
            source: 'MANUAL',
          })
        }}
      />
    </Card>
  )
}

/* ---------- 保険金・年金 ---------- */

function BenefitsTab({ caseId }: { caseId: string }) {
  const { data, isLoading } = useBenefits(caseId)
  const update = useUpdateBenefit(caseId)

  if (isLoading) return <Spinner />
  const items = data?.items ?? []

  return (
    <Card title="保険金・年金など受け取るもの">
      {items.length === 0 ? (
        <EmptyState
          title="まだ登録されていません"
          description="保険証券や年金関係の書類をアップロードすると候補が表示されます。"
        />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-line)]">
          {items.map((b) => (
            <li key={b.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{b.name}</span>
                <span className="badge badge-gray">{BENEFIT_KIND_LABEL[b.kind]}</span>
                <span className={`badge ${CONTRACT_PROGRESS_META[b.progress].className}`}>
                  {CONTRACT_PROGRESS_META[b.progress].label}
                </span>
              </div>
              <p className="mt-0.5 text-[var(--color-ink-muted)]">
                {b.provider ? `${b.provider} ・ ` : ''}
                {formatYen(b.amount)}
              </p>
              {b.deadline && (
                <p className="mt-0.5">
                  <DeadlineChip deadline={b.deadline} />
                </p>
              )}
              <label className="mt-2 flex w-44 flex-col gap-1 text-sm font-bold">
                状態
                <select
                  className="select"
                  value={b.progress}
                  onChange={(e) =>
                    void update.mutateAsync({ id: b.id, progress: e.target.value as ContractProgress })
                  }
                >
                  <option value="NOT_STARTED">未対応</option>
                  <option value="CONTACTED">連絡済み</option>
                  <option value="COMPLETED">完了</option>
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ---------- 追加用モーダル ---------- */

function ItemModal({
  open,
  title,
  kinds,
  partyLabel,
  withAmount = true,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  kinds: Record<string, string>
  partyLabel: string
  withAmount?: boolean
  onClose: () => void
  onSubmit: (v: { name: string; kind: string; party: string; amount?: number }) => Promise<void>
}) {
  const kindKeys = Object.keys(kinds)
  const [name, setName] = useState('')
  const [kind, setKind] = useState(kindKeys[0])
  const [party, setParty] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>キャンセル</Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={async () => {
              if (!name.trim()) {
                setError('名称を入力してください。')
                return
              }
              setPending(true)
              try {
                await onSubmit({
                  name: name.trim(),
                  kind,
                  party: party.trim(),
                  amount: amount ? Number(amount) : undefined,
                })
                setName('')
                setParty('')
                setAmount('')
                setError(undefined)
                onClose()
              } finally {
                setPending(false)
              }
            }}
          >
            追加する
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput
          label="名称"
          required
          value={name}
          error={error}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectInput label="種別" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kindKeys.map((k) => (
            <option key={k} value={k}>
              {kinds[k]}
            </option>
          ))}
        </SelectInput>
        <TextInput label={partyLabel} value={party} onChange={(e) => setParty(e.target.value)} />
        {withAmount && (
          <TextInput
            label="金額（円）"
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
      </div>
    </Modal>
  )
}
