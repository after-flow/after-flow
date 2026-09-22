import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  useAssets,
  useBenefits,
  useConfirmAsset,
  useConfirmLiability,
  useContracts,
  useCreateAsset,
  useCreateContract,
  useCreateLiability,
  useLiabilities,
  useReportBenefitProgress,
  useReportContractProgress,
  useSetContractPolicy,
  useUpdateAsset,
  useUpdateContract,
  useUpdateLiability,
} from '@/lib/api/queries'
import type { Asset, Contract, ContractPolicy, ContractProgress, Liability } from '@aftercare/public-contracts'
import { formatYen } from '@/lib/format'
import {
  ASSET_KIND_LABEL,
  BENEFIT_KIND_LABEL,
  CONTRACT_KIND_LABEL,
  CONTRACT_PROGRESS_META,
  LIABILITY_KIND_LABEL,
} from '@/lib/labels'
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Field,
  Loading,
  Notice,
  Page,
  PageHeader,
  Tabs,
  inputClass,
} from '@/kit/kit'
import { Due, LockNotice, useCaseBase, useLock } from '@/kit/domain'
import { CONTRACT_POLICY_WORD } from '@/kit/words'

type Tab = 'assets' | 'liabilities' | 'contracts' | 'benefits'
type EditableTab = Exclude<Tab, 'benefits'>

/**
 * 財産・契約。
 *
 * 利用場面：通帳や郵便物を見ながら「故人が何を持っていて、何を契約していたか」を把握する。
 * ここはAIが見つけたものの台帳で、毎日開く場所ではない。
 * 未確認のものだけが利用者の出番なので、その件数をタブに出す。
 */
export function PropertyScreen() {
  const { caseId } = useCaseBase()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab | null) ?? 'assets'
  const assets = useAssets(caseId)
  const liabilities = useLiabilities(caseId)
  const contracts = useContracts(caseId)
  const benefits = useBenefits(caseId)
  const [adding, setAdding] = useState(false)
  // 登録済みの財産・借金・契約を直す（金額の間違い・名前の打ち間違いなど）
  const [editing, setEditing] = useState<{ kind: EditableTab; item: Asset | Liability | Contract } | null>(null)

  const a = assets.data?.items ?? []
  const l = liabilities.data?.items ?? []
  const c = contracts.data?.items ?? []
  const b = benefits.data?.items ?? []
  const sum = (xs: { amount?: number }[]) => xs.reduce((s, x) => s + (x.amount ?? 0), 0)
  const unconfirmed = (xs: { confirmation: string }[]) => xs.filter((x) => x.confirmation === 'UNCONFIRMED').length

  return (
    <Page>
      <PageHeader
        title="財産・契約"
        description="AIが書類から見つけたものと、自分で追加したものの一覧です。"
        actions={
          tab !== 'benefits' && (
            <Button icon="plus" onClick={() => setAdding(true)}>
              {tab === 'assets' ? '財産' : tab === 'liabilities' ? '借金など' : '契約'}を追加
            </Button>
          )
        }
      />

      <LockNotice caseId={caseId} compact />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* 金額は桁が多いので、スマホでは横幅いっぱいに出す（半分の幅だと「24,691,356円」でも札からはみ出す） */}
        <Stat wide label="財産（金額が分かる分）" value={formatYen(sum(a))} />
        <Stat wide label="借金など（金額が分かる分）" value={formatYen(sum(l))} />
        <Stat label="契約" value={`${c.length}件`} sub={`どうするか未定 ${c.filter((x) => x.policy === 'UNDECIDED').length}件`} />
        <Stat label="受け取れるお金" value={`${b.length}件`} sub={b.length > 0 ? `未請求 ${b.filter((x) => x.progress === 'NOT_STARTED').length}件` : undefined} />
      </div>

      <div className="overflow-hidden rounded-lg border border-rd-border bg-rd-card">
        <div className="px-4 pt-1">
          <Tabs
            value={tab}
            onChange={(id) => setParams(id === 'assets' ? {} : { tab: id }, { replace: true })}
            items={[
              { id: 'assets', label: '財産', count: unconfirmed(a) || undefined, countTone: 'red' },
              { id: 'liabilities', label: '借金など', count: unconfirmed(l) || undefined, countTone: 'red' },
              { id: 'contracts', label: '契約' },
              { id: 'benefits', label: '受け取れるお金' },
            ]}
          />
        </div>
        {/* タブを切り替えたら中身を短くふわっと出し、切り替わったことを伝える */}
        <div key={tab} className="animate-fade-in">
          {tab === 'assets' && (assets.data ? <AssetsTable caseId={caseId} items={a} onEdit={(item) => setEditing({ kind: 'assets', item })} /> : <Loading />)}
          {tab === 'liabilities' && (liabilities.data ? <LiabilitiesTable caseId={caseId} items={l} onEdit={(item) => setEditing({ kind: 'liabilities', item })} /> : <Loading />)}
          {tab === 'contracts' && (contracts.data ? <ContractsTable caseId={caseId} items={c} onEdit={(item) => setEditing({ kind: 'contracts', item })} /> : <Loading />)}
          {tab === 'benefits' && (benefits.data ? <BenefitsTable caseId={caseId} /> : <Loading />)}
        </div>
      </div>

      {adding && tab !== 'benefits' && <ItemDialog caseId={caseId} kind={tab} onClose={() => setAdding(false)} />}
      {editing && (
        <ItemDialog key={editing.item.id} caseId={caseId} kind={editing.kind} item={editing.item} onClose={() => setEditing(null)} />
      )}
    </Page>
  )
}

function Stat({ label, value, sub, wide }: { label: string; value: string; sub?: string; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg border border-rd-border bg-rd-card px-4 py-3 ${wide ? 'col-span-2 sm:col-span-1' : ''}`}>
      <p className="text-[0.82rem] font-bold text-rd-text-2">{label}</p>
      <p className="mt-0.5 text-[1.2rem] font-bold leading-tight">{value}</p>
      {sub && <p className="text-[0.8rem] text-rd-text-3">{sub}</p>}
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-[0.94rem]">
        <thead className="border-b border-rd-border bg-rd-bg text-[0.82rem] text-rd-text-2">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-bold ${i === head.length - 1 ? 'text-right' : ''}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

const tr = 'border-b border-rd-border-2 last:border-b-0 align-middle'
// 表は横にスクロールできるので、金額やボタンは折り返さず1行で出す（ボタンは置き場所に合わせて折り返すため、セルの中では細く縦に折れてしまう）
const td = 'px-4 py-2.5'

/** 名前と「直す」ボタンを並べる */
function NameCell({ name, onEdit }: { name: string; onEdit: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <p className="font-bold">{name}</p>
      <Button size="sm" variant="ghost" icon="pencil" className="-my-1 shrink-0" onClick={onEdit} aria-label={`${name}を直す`}>
        直す
      </Button>
    </div>
  )
}

function SourceMark({ source }: { source: 'AI' | 'MANUAL' }) {
  return <span className="text-[0.8rem] text-rd-text-3">{source === 'AI' ? 'AIが書類から見つけた' : '自分で追加した'}</span>
}

function AssetsTable({ caseId, items, onEdit }: { caseId: string; items: Asset[]; onEdit: (x: Asset) => void }) {
  const confirm = useConfirmAsset(caseId)
  if (items.length === 0) return <Empty icon="bank" title="まだ財産は登録されていません">通帳や不動産の書類を追加すると、AIが見つけてここに並べます。</Empty>
  return (
    <Table head={['名前', '種類', '金額', '内容の確認']}>
      {items.map((x) => (
        <tr key={x.id} className={tr}>
          <td className={td}>
            <NameCell name={x.name} onEdit={() => onEdit(x)} />
            <p className="flex gap-2 text-[0.82rem] text-rd-text-2">
              {x.institution}
              <SourceMark source={x.source} />
            </p>
            {x.taxAttention && <p className="mt-0.5 text-[0.82rem] text-rd-warning-text">税務上の判断が必要な場合があります。税理士にご相談ください。</p>}
          </td>
          <td className={`${td} text-rd-text-2`}>{ASSET_KIND_LABEL[x.kind]}</td>
          <td className={`${td} font-bold whitespace-nowrap`}>{formatYen(x.amount)}</td>
          <td className={`${td} text-right whitespace-nowrap`}>
            {x.confirmation === 'CONFIRMED' ? (
              <Badge tone="green" icon="check">確認済み</Badge>
            ) : (
              <Button size="sm" variant="primary" disabled={confirm.isPending} onClick={() => void confirm.mutateAsync({ id: x.id, expectedVersion: x.version })}>
                合っている
              </Button>
            )}
          </td>
        </tr>
      ))}
    </Table>
  )
}

function LiabilitiesTable({ caseId, items, onEdit }: { caseId: string; items: Liability[]; onEdit: (x: Liability) => void }) {
  const confirm = useConfirmLiability(caseId)
  return (
    <>
      <div className="px-4 pt-3">
        <Notice tone="info">故人の預金などから借金を返すと、相続放棄ができなくなることがあります。単純承認を選ぶまでは記録だけにしてください。</Notice>
      </div>
      {items.length === 0 ? (
        <Empty title="借金などは見つかっていません" />
      ) : (
        <Table head={['名前', '種類', '金額', '内容の確認']}>
          {items.map((x) => (
            <tr key={x.id} className={tr}>
              <td className={td}>
                <NameCell name={x.name} onEdit={() => onEdit(x)} />
                <p className="flex gap-2 text-[0.82rem] text-rd-text-2">
                  {x.creditor}
                  <SourceMark source={x.source} />
                </p>
              </td>
              <td className={`${td} text-rd-text-2`}>{LIABILITY_KIND_LABEL[x.kind]}</td>
              <td className={`${td} font-bold whitespace-nowrap`}>{formatYen(x.amount)}</td>
              <td className={`${td} text-right whitespace-nowrap`}>
                {x.confirmation === 'CONFIRMED' ? (
                  <Badge tone="green" icon="check">確認済み</Badge>
                ) : (
                  <Button size="sm" variant="primary" disabled={confirm.isPending} onClick={() => void confirm.mutateAsync({ id: x.id, expectedVersion: x.version })}>
                    合っている
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  )
}

const POLICIES: ContractPolicy[] = ['UNDECIDED', 'CONTINUE', 'TRANSFER', 'CANCEL']
/** 名義変更・解約は財産の処分にあたりうるので、本人が単純承認を選ぶまで選べない */
const LOCKED_POLICIES: ContractPolicy[] = ['TRANSFER', 'CANCEL']

function ContractsTable({ caseId, items, onEdit }: { caseId: string; items: Contract[]; onEdit: (x: Contract) => void }) {
  const setPolicy = useSetContractPolicy(caseId)
  const reportProgress = useReportContractProgress(caseId)
  const { locked } = useLock(caseId)
  if (items.length === 0) return <Empty icon="plug" title="まだ契約は登録されていません">電気・ガス・携帯電話・サブスクなどを追加しておくと、止め忘れを防げます。</Empty>
  return (
    <Table head={['契約', '種類', 'どうするか', '対応状況']}>
      {items.map((x) => (
        <tr key={x.id} className={tr}>
          <td className={td}>
            <NameCell name={x.name} onEdit={() => onEdit(x)} />
            <p className="flex gap-2 text-[0.82rem] text-rd-text-2">
              {x.provider}
              <SourceMark source={x.source} />
            </p>
            {!locked && x.guidance?.where && <p className="mt-0.5 text-[0.82rem] text-rd-text-2">連絡先：{x.guidance.where}</p>}
          </td>
          <td className={`${td} text-rd-text-2`}>{CONTRACT_KIND_LABEL[x.kind]}</td>
          <td className={td}>
            <select
              className={`${inputClass} h-9 w-36 text-[0.9rem]`}
              aria-label={`${x.name}をどうするか`}
              value={x.policy}
              onChange={(e) => void setPolicy.mutateAsync({ id: x.id, expectedVersion: x.version, policy: e.target.value as ContractPolicy })}
            >
              {POLICIES.map((p) => (
                <option key={p} value={p} disabled={locked && LOCKED_POLICIES.includes(p)}>
                  {CONTRACT_POLICY_WORD[p]}
                  {locked && LOCKED_POLICIES.includes(p) ? '（いまは選べません）' : ''}
                </option>
              ))}
            </select>
          </td>
          <td className={`${td} text-right whitespace-nowrap`}>
            <select
              className={`${inputClass} ml-auto h-9 w-28 text-[0.9rem]`}
              aria-label={`${x.name}の対応状況`}
              value={x.progress}
              onChange={(e) => void reportProgress.mutateAsync({ id: x.id, expectedVersion: x.version, progress: e.target.value as ContractProgress })}
            >
              {(Object.keys(CONTRACT_PROGRESS_META) as ContractProgress[]).map((p) => (
                <option key={p} value={p}>{CONTRACT_PROGRESS_META[p].label}</option>
              ))}
            </select>
          </td>
        </tr>
      ))}
    </Table>
  )
}

function BenefitsTable({ caseId }: { caseId: string }) {
  const { data } = useBenefits(caseId)
  const reportProgress = useReportBenefitProgress(caseId)
  const items = data?.items ?? []
  if (items.length === 0) return <Empty title="受け取れるお金は見つかっていません">保険証券や年金の書類を追加すると、AIが探します。</Empty>
  return (
    <Table head={['名前', '種類', '金額', '請求の期限', '対応状況']}>
      {items.map((x) => (
        <tr key={x.id} className={tr}>
          <td className={td}>
            <p className="font-bold">{x.name}</p>
            <p className="text-[0.82rem] text-rd-text-2">{x.provider}</p>
          </td>
          <td className={`${td} text-rd-text-2`}>{BENEFIT_KIND_LABEL[x.kind]}</td>
          <td className={`${td} font-bold whitespace-nowrap`}>{formatYen(x.amount)}</td>
          <td className={td}>
            <Due deadline={x.deadline} done={x.progress === 'COMPLETED'} />
          </td>
          <td className={`${td} text-right whitespace-nowrap`}>
            <select
              className={`${inputClass} ml-auto h-9 w-28 text-[0.9rem]`}
              aria-label={`${x.name}の対応状況`}
              value={x.progress}
              onChange={(e) => void reportProgress.mutateAsync({ id: x.id, expectedVersion: x.version, progress: e.target.value as ContractProgress })}
            >
              {(Object.keys(CONTRACT_PROGRESS_META) as ContractProgress[]).map((p) => (
                <option key={p} value={p}>{CONTRACT_PROGRESS_META[p].label}</option>
              ))}
            </select>
          </td>
        </tr>
      ))}
    </Table>
  )
}

/** 財産・借金・契約の追加と、登録済みのものを直す画面（item があれば直す） */
function ItemDialog({
  caseId,
  kind,
  item,
  onClose,
}: {
  caseId: string
  kind: EditableTab
  item?: Asset | Liability | Contract
  onClose: () => void
}) {
  const createAsset = useCreateAsset(caseId)
  const createLiability = useCreateLiability(caseId)
  const createContract = useCreateContract(caseId)
  const updateAsset = useUpdateAsset(caseId)
  const updateLiability = useUpdateLiability(caseId)
  const updateContract = useUpdateContract(caseId)

  const initialParty =
    item == null
      ? ''
      : kind === 'assets'
        ? ((item as Asset).institution ?? '')
        : kind === 'liabilities'
          ? ((item as Liability).creditor ?? '')
          : ((item as Contract).provider ?? '')
  const initialAmount =
    item && kind !== 'contracts' && (item as Asset | Liability).amount != null
      ? (item as Asset | Liability).amount!.toLocaleString('ja-JP')
      : ''
  const [name, setName] = useState(item?.name ?? '')
  const [type, setType] = useState<string>(item?.kind ?? '')
  const [party, setParty] = useState(initialParty)
  const [amount, setAmount] = useState(initialAmount)

  const kinds = kind === 'assets' ? ASSET_KIND_LABEL : kind === 'liabilities' ? LIABILITY_KIND_LABEL : CONTRACT_KIND_LABEL
  const noun = kind === 'assets' ? '財産' : kind === 'liabilities' ? '借金など' : '契約'
  const selected = type || Object.keys(kinds)[0]
  const busy = [createAsset, createLiability, createContract, updateAsset, updateLiability, updateContract].some(
    (m) => m.isPending,
  )

  return (
    <Confirm
      open
      title={item ? `${noun}を直す` : `${noun}を追加`}
      confirmLabel={item ? '直す' : '追加する'}
      busy={busy}
      disabled={!name.trim()}
      onClose={onClose}
      onConfirm={async () => {
        // 数字が1つも無ければ（「不明」など）金額は空にする。0円として保存しない。直すときに空にしたら消す（null）
        const digits = amount.replace(/[^\d]/g, '')
        const n = digits ? Number(digits) : undefined
        const nm = name.trim()
        // 追加時は空欄を送らない（undefined）。直すときは空文字で消す（このフィールドは null を受け付けない）
        const party2 = party.trim() || undefined
        const partyForUpdate = party.trim()
        if (kind === 'assets') {
          if (item) await updateAsset.mutateAsync({ id: item.id, expectedVersion: item.version, name: nm, kind: selected as Asset['kind'], institution: partyForUpdate, amount: n ?? null })
          else await createAsset.mutateAsync({ name: nm, kind: selected as Asset['kind'], institution: party2, amount: n })
        } else if (kind === 'liabilities') {
          if (item) await updateLiability.mutateAsync({ id: item.id, expectedVersion: item.version, name: nm, kind: selected as Liability['kind'], creditor: partyForUpdate, amount: n ?? null })
          else await createLiability.mutateAsync({ name: nm, kind: selected as Liability['kind'], creditor: party2, amount: n })
        } else {
          if (item) await updateContract.mutateAsync({ id: item.id, expectedVersion: item.version, name: nm, kind: selected as Contract['kind'], provider: partyForUpdate })
          else await createContract.mutateAsync({ name: nm, kind: selected as Contract['kind'], provider: party2 })
        }
        onClose()
      }}
    >
      <div className="flex flex-col gap-3.5">
        <Field label="名前" required>
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'contracts' ? '例：インターネット回線' : '例：○○銀行 普通預金'}
            />
          )}
        </Field>
        <Field label="種類">
          {(id) => (
            <select id={id} className={inputClass} value={selected} onChange={(e) => setType(e.target.value)}>
              {Object.entries(kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={kind === 'assets' ? '金融機関や場所' : kind === 'liabilities' ? '借りている先' : '契約先'}>
          {(id) => <input id={id} className={inputClass} value={party} onChange={(e) => setParty(e.target.value)} />}
        </Field>
        {kind !== 'contracts' && (
          <Field label="金額（円）" hint="分からなければ空欄で構いません">
            {(id) => (
              <input id={id} inputMode="numeric" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} />
            )}
          </Field>
        )}
        {item?.source === 'AI' && (
          <p className="text-[0.86rem] text-rd-text-2">AIが書類から見つけたものです。書類と見比べて直してください。</p>
        )}
      </div>
    </Confirm>
  )
}
