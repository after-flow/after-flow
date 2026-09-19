import { useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  useCaseOverview,
  useCreatePerson,
  useDeletePerson,
  usePersons,
  useSetInheritanceDecision,
  useUpdatePerson,
} from '@/api/queries'
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  PageHeader,
  SelectInput,
  Spinner,
  TextInput,
} from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { Term } from '@/components/ui/Term'
import { INHERITANCE_METHOD_LABEL, SPECIAL_CIRCUMSTANCE_META } from '@/lib/labels'
import { Icon } from '@/components/ui/Icon'
import { PersonAvatar, PersonCard } from '@/components/domain/PersonCard'
import { DecisionProgress } from '@/components/domain/DecisionProgress'
import type { InheritanceMethod, Person } from '@/api/types'

export function FamilyPage() {
  const { caseId = '' } = useParams()
  const { data: overview } = useCaseOverview(caseId)
  const { data, isLoading } = usePersons(caseId)
  const setDecision = useSetInheritanceDecision(caseId)
  const del = useDeletePerson(caseId)

  const [editing, setEditing] = useState<Person | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [deleting, setDeleting] = useState<Person | null>(null)

  if (isLoading) return <Spinner />
  const persons = data?.items ?? []
  const heirs = persons.filter((p) => p.isHeir)
  const decision = overview?.inheritanceDecision

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="家族・関係者"
        title="家族・関係者"
        description="相続人になりうる方を登録すると、手続きの分岐や期限の管理に反映されます。"
        action={
          <Button variant="secondary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={16} />
            関係者を追加する
          </Button>
        }
      />

      {/* ---- 相続方法の判断状況（放棄前ロックの解除条件） ---- */}
      {decision && <DecisionProgress decision={decision} />}

      <Card title="相続人ごとの判断" bodyClassName="p-3 sm:p-4">
        <Banner tone="warning" title="どの方法を選ぶかは法的な判断です">
          <p className="text-sm">
            本サービスでは判断はいたしません。迷われる場合は弁護士へご相談ください。
            <Term word="限定承認" />
            は相続人全員でそろって申し立てる必要があります。期限内に判断できない場合は、家庭裁判所に申し立てて期間を延ばせることがあります。
          </p>
        </Banner>

        {heirs.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="相続人がまだ登録されていません"
              description="「関係者を追加する」から、相続人になりうる方を登録してください。"
            />
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {heirs.map((p) => {
              const current = decision?.perHeir.find((h) => h.personId === p.id)?.method ?? null
              const settled = current != null
              return (
                <li key={p.id}>
                  <div
                    className="card-quiet p-3.5 sm:p-4"
                    style={{
                      borderLeft: `4px solid ${
                        settled ? 'var(--color-state-green)' : 'var(--color-state-yellow)'
                      }`,
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <PersonAvatar
                        person={p}
                        tone={
                          settled
                            ? { fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' }
                            : { fg: 'var(--color-state-yellow)', bg: 'var(--color-state-yellow-soft)' }
                        }
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-bold">{p.name}</span>
                          <span className="text-sm text-[var(--color-ink-muted)]">
                            {p.relationship}
                          </span>
                          {p.specialCircumstance && (
                            <span className="badge badge-yellow">
                              <Icon name="warning" size={13} />
                              {SPECIAL_CIRCUMSTANCE_META[p.specialCircumstance].label}
                            </span>
                          )}
                        </div>
                        <span
                          className={`badge mt-1 ${settled ? 'badge-green' : 'badge-yellow'}`}
                        >
                          <Icon name={settled ? 'check-circle' : 'circle'} size={13} />
                          {settled ? INHERITANCE_METHOD_LABEL[current] : 'まだ決めていません'}
                        </span>
                      </div>

                      <label className="flex flex-col gap-1 text-sm font-bold">
                        <span className="visually-hidden">{p.name} さんの相続方法</span>
                        選んだ方法
                        <select
                          className="select min-w-[10rem]"
                          value={current ?? ''}
                          onChange={(e) =>
                            void setDecision.mutateAsync({
                              personId: p.id,
                              method: (e.target.value || null) as InheritanceMethod | null,
                            })
                          }
                        >
                          <option value="">まだ決めていない</option>
                          {(Object.keys(INHERITANCE_METHOD_LABEL) as InheritanceMethod[]).map(
                            (m) => (
                              <option key={m} value={m}>
                                {INHERITANCE_METHOD_LABEL[m]}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* ---- 関係者一覧 ---- */}
      <Card title="登録されている方" bodyClassName="p-3 sm:p-4">
        {persons.length === 0 ? (
          <EmptyState title="まだ登録がありません" />
        ) : (
          <ul className="flex flex-col gap-2">
            {persons.map((p) => (
              <li key={p.id}>
                <PersonCard
                  person={p}
                  actions={
                    <>
                      <Button size="sm" onClick={() => setEditing(p)}>
                        <Icon name="pencil" size={15} />
                        編集する
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(p)}>
                        削除する
                      </Button>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PersonModal
        caseId={caseId}
        open={showNew || editing != null}
        person={editing}
        onClose={() => {
          setShowNew(false)
          setEditing(null)
        }}
      />

      <ConfirmDialog
        open={deleting != null}
        title={`${deleting?.name ?? ''} さんの登録を削除しますか？`}
        description="削除すると、この方に関する情報は一覧から表示されなくなります。"
        confirmLabel="削除する"
        confirmVariant="danger"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}

function PersonModal({
  caseId,
  open,
  person,
  onClose,
}: {
  caseId: string
  open: boolean
  person: Person | null
  onClose: () => void
}) {
  const create = useCreatePerson(caseId)
  const update = useUpdatePerson(caseId)
  const [form, setForm] = useState({
    name: '',
    nameKana: '',
    relationship: '',
    isHeir: true,
    specialCircumstance: '',
    contact: '',
    note: '',
  })
  const [error, setError] = useState<string | undefined>()
  const [key, setKey] = useState('')

  // モーダルを開くたびに対象の内容で初期化する
  const nextKey = `${open}-${person?.id ?? 'new'}`
  if (key !== nextKey) {
    setKey(nextKey)
    setForm({
      name: person?.name ?? '',
      nameKana: person?.nameKana ?? '',
      relationship: person?.relationship ?? '',
      isHeir: person?.isHeir ?? true,
      specialCircumstance: person?.specialCircumstance ?? '',
      contact: person?.contact ?? '',
      note: person?.note ?? '',
    })
    setError(undefined)
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function submit() {
    if (!form.name.trim()) {
      setError('お名前を入力してください。')
      return
    }
    const payload: Partial<Person> = {
      name: form.name.trim(),
      nameKana: form.nameKana.trim() || undefined,
      relationship: form.relationship.trim() || '—',
      role: form.isHeir ? 'HEIR_CANDIDATE' : 'RELATED',
      isHeir: form.isHeir,
      specialCircumstance: (form.specialCircumstance || null) as Person['specialCircumstance'],
      contact: form.contact.trim() || undefined,
      note: form.note.trim() || undefined,
    }
    if (person) await update.mutateAsync({ id: person.id, ...payload })
    else await create.mutateAsync(payload)
    onClose()
  }

  const scHint = form.specialCircumstance
    ? SPECIAL_CIRCUMSTANCE_META[form.specialCircumstance]?.hint
    : undefined

  return (
    <Modal
      open={open}
      title={person ? '関係者の情報を編集する' : '関係者を追加する'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>キャンセル</Button>
          <Button
            variant="primary"
            disabled={create.isPending || update.isPending}
            onClick={() => void submit()}
          >
            保存する
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput
          label="お名前"
          required
          value={form.name}
          error={error}
          onChange={(e) => set('name', e.target.value)}
        />
        <TextInput
          label="ふりがな"
          value={form.nameKana}
          onChange={(e) => set('nameKana', e.target.value)}
        />
        <TextInput
          label="故人との続柄"
          hint="例：配偶者、長男、姪"
          value={form.relationship}
          onChange={(e) => set('relationship', e.target.value)}
        />
        <Checkbox
          checked={form.isHeir}
          onChange={(v) => set('isHeir', v)}
          label="相続人になりうる方として登録する"
        />
        <SelectInput
          label="特別な事情"
          hint="該当する場合、必要になりうる手続きをご案内します。"
          value={form.specialCircumstance}
          onChange={(e) => set('specialCircumstance', e.target.value)}
        >
          <option value="">特になし</option>
          {Object.entries(SPECIAL_CIRCUMSTANCE_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </SelectInput>
        {scHint && (
          <Banner tone="warning">
            {scHint}
            <br />
            該当する手続きは法的な判断を伴うため、弁護士・司法書士へのご相談をおすすめします。
          </Banner>
        )}
        <TextInput
          label="連絡先"
          hint="ご本人以外の連絡先を登録する場合は、あらかじめご本人の了解を得てください。"
          value={form.contact}
          onChange={(e) => set('contact', e.target.value)}
        />
        <TextInput label="メモ" value={form.note} onChange={(e) => set('note', e.target.value)} />
      </div>
    </Modal>
  )
}
