import { useState } from 'react'
import {
  useCaseOverview,
  useCreatePerson,
  useDeletePerson,
  usePersons,
  useSetInheritanceDecision,
  useTasks,
  useUpdatePerson,
} from '@/lib/api/queries'
import type { InheritanceMethod, Person } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { daysUntil, formatDate } from '@/lib/format'
import { INHERITANCE_METHOD_LABEL, SPECIAL_CIRCUMSTANCE_META } from '@/lib/labels'
import { GLOSSARY } from '@/lib/terms'
import {
  Badge,
  Button,
  Checkbox,
  Confirm,
  Empty,
  Field,
  LinkButton,
  Loading,
  Notice,
  Page,
  PageHeader,
  Panel,
  inputClass,
} from '@/kit/kit'
import { useCaseBase } from '@/kit/domain'
import { METHOD_HINT } from '@/kit/words'

const METHODS = Object.keys(INHERITANCE_METHOD_LABEL) as InheritanceMethod[]
const GLOSSARY_KEY: Record<InheritanceMethod, string> = {
  SIMPLE_ACCEPTANCE: '単純承認',
  LIMITED_ACCEPTANCE: '限定承認',
  RENUNCIATION: '相続放棄',
}

/**
 * 家族・相続人。
 *
 * この画面の主役は「相続の方法を決める」こと。
 * 決まるまで財産に触れる導線は閉じたままになるので、画面の最上部に置く。
 * どの方法を選ぶかは法的な判断で、アプリは判断しない。選んだ結果を記録するだけにする。
 */
export function FamilyScreen() {
  const { caseId, base } = useCaseBase()
  const overview = useCaseOverview(caseId)
  const tasks = useTasks(caseId)
  const persons = usePersons(caseId)
  const setDecision = useSetInheritanceDecision(caseId)
  const del = useDeletePerson(caseId)

  const [editing, setEditing] = useState<Person | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Person | null>(null)
  const [choosing, setChoosing] = useState<{ person: Person; method: InheritanceMethod | null } | null>(null)

  if (!persons.data || !overview.data) return <Loading />

  const all = persons.data.items
  const heirs = all.filter((p) => p.isHeir)
  const decision = overview.data.inheritanceDecision
  const decidedCount = decision.perHeir.filter((h) => h.method != null).length
  const left = daysUntil(decision.deliberationDeadline)
  // 「相続の方法を決める」手続き。全員の記録が済んだら、そちらも完了にできるよう案内する
  const decisionTask = tasks.data?.items.find((t) => t.stage === 'decision' && t.status !== 'COMPLETED')

  // 限定承認は、放棄した人を除く相続人全員で行う（民法923条）。判断はせず、記録の食い違いだけを伝える
  const heirMethods = decision.perHeir.map((h) => h.method).filter((m) => m !== 'RENUNCIATION')
  const limitedConflict =
    heirMethods.includes('LIMITED_ACCEPTANCE') && heirMethods.some((m) => m !== 'LIMITED_ACCEPTANCE')

  return (
    <Page>
      <PageHeader
        title="家族・相続人"
        description="相続人になる可能性のある方と、それぞれが選んだ相続の方法を記録します。"
        actions={
          <Button icon="plus" onClick={() => setEditing('new')}>
            家族・関係者を追加
          </Button>
        }
      />

      <Panel
        title="相続の方法"
        action={
          decision.deliberationDeadline && (
            <span className="text-[0.86rem] text-rd-text-2">
              決める期限 <strong className="text-rd-text">{formatDate(decision.deliberationDeadline, { weekday: true })}</strong>
              {left != null && left >= 0 && <span className={left <= 14 ? 'ml-1 font-bold text-rd-danger-text' : 'ml-1'}>（あと{left}日）</span>}
            </span>
          )
        }
        padded={false}
      >
        <div className="flex flex-col gap-3 p-4">
          {limitedConflict && (
            <Notice tone="warning" title="限定承認は、相続人全員がそろって申し立てるものです">
              相続放棄をした方を除く相続人全員で、家庭裁判所に申し立てる必要があります（民法923条）。いまの記録には、限定承認とそれ以外の方法（または未定）が混ざっています。進め方は弁護士・司法書士にご相談ください。
            </Notice>
          )}
          {decision.decided ? (
            <Notice
              tone="info"
              title="全員の方法を記録しました"
              action={
                decisionTask && (
                  <LinkButton to={`${base}/tasks/${decisionTask.id}`} size="sm">
                    手続きを完了にする
                  </LinkButton>
                )
              }
            >
              ここでの記録は、家庭裁判所での手続き（申述）の代わりにはなりません。相続放棄・限定承認を選んだ方は、家庭裁判所で認められた後も、故人の財産を自分の判断で使ったり処分したりしないでください。
            </Notice>
          ) : (
            <div className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-rd-shade">
                <div className="h-full rounded-full bg-rd-success transition-[width] duration-500 ease-out" style={{ width: `${heirs.length ? (decidedCount / heirs.length) * 100 : 0}%` }} />
              </div>
              <span className="shrink-0 text-[0.9rem] font-bold">
                {decidedCount}人が記録済み（{heirs.length}人中）
              </span>
            </div>
          )}
          <p className="text-[0.86rem] leading-relaxed text-rd-text-2">
            どの方法を選ぶかは法的な判断です。このアプリは判断をせず、決めた結果を記録するだけです。迷う場合は弁護士にご相談ください。
            期限内に決められない場合は、家庭裁判所に申し立てて期間を延ばせることがあります。
          </p>
          <dl className="grid gap-x-4 gap-y-1 rounded-md bg-rd-bg px-3 py-2 text-[0.9rem] sm:grid-cols-3">
            {METHODS.map((m) => (
              <div key={m}>
                <dt className="inline font-bold">{INHERITANCE_METHOD_LABEL[m]}</dt>
                <dd className="ml-1.5 inline text-rd-text-2">{METHOD_HINT[m]}</dd>
              </div>
            ))}
          </dl>
        </div>

        {heirs.length === 0 ? (
          <Empty icon="family" title="相続人がまだ登録されていません">「家族・関係者を追加」から登録してください。</Empty>
        ) : (
          <ul className="border-t border-rd-border">
            {heirs.map((p) => {
              const current = decision.perHeir.find((h) => h.personId === p.id)?.method ?? null
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-rd-border-2 px-4 py-3 last:border-b-0">
                  <Avatar name={p.name} done={current != null} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{p.name}</span>
                      <span className="text-[0.86rem] text-rd-text-2">{p.relationship}</span>
                      {p.specialCircumstance && (
                        <Badge tone="yellow" icon="warning">{SPECIAL_CIRCUMSTANCE_META[p.specialCircumstance].label}</Badge>
                      )}
                    </p>
                  </div>
                  <div role="radiogroup" aria-label={`${p.name}さんの相続の方法`} className="grid w-full grid-cols-4 gap-1 rounded-md bg-rd-shade p-1 sm:flex sm:w-auto">
                    {[null, ...METHODS].map((m) => {
                      const on = current === m
                      return (
                        <button
                          key={m ?? 'none'}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => !on && setChoosing({ person: p, method: m })}
                          className={`h-9 rounded px-2 text-[0.86rem] font-bold whitespace-nowrap sm:px-3 ${
                            on ? (m ? 'bg-rd-card text-rd-success-text shadow-sm' : 'bg-rd-card text-rd-text shadow-sm') : 'text-rd-text-2 hover:text-rd-text'
                          }`}
                        >
                          {m ? INHERITANCE_METHOD_LABEL[m] : '未定'}
                        </button>
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel title="登録されている方" padded={false}>
        {all.length === 0 ? (
          <Empty icon="family" title="まだ登録がありません" />
        ) : (
          <ul>
            {all.map((p) => (
              /*
                狭い画面では「編集」「削除」を名前の下の行に送る。1行に並べると名前の列が 40px ほどになり、
                「相続人」の札がはみ出していた
              */
              <li
                key={p.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-rd-border-2 px-4 py-3 last:border-b-0 sm:flex"
              >
                <Avatar name={p.name} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{p.name}</span>
                    <span className="text-[0.86rem] text-rd-text-2">{p.relationship}</span>
                    {p.isHeir && <Badge tone="blue">相続人</Badge>}
                  </p>
                  {(p.note || p.contact) && (
                    <p className="truncate text-[0.82rem] text-rd-text-2">{[p.note, p.contact].filter(Boolean).join('・')}</p>
                  )}
                </div>
                <div className="col-start-2 -ml-3 flex gap-1 sm:ml-0">
                  <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(p)}>
                    編集
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rd-danger-text" onClick={() => setDeleting(p)}>
                    削除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Confirm
        open={choosing != null}
        title={
          choosing?.method
            ? `${choosing.person.name}さんは「${INHERITANCE_METHOD_LABEL[choosing.method]}」を選んだと記録しますか？`
            : `${choosing?.person.name ?? ''}さんを「未定」に戻しますか？`
        }
        description={choosing?.method ? GLOSSARY[GLOSSARY_KEY[choosing.method]]?.plain : undefined}
        confirmLabel="記録する"
        busy={setDecision.isPending}
        onClose={() => setChoosing(null)}
        onConfirm={async () => {
          if (choosing) await setDecision.mutateAsync({ personId: choosing.person.id, method: choosing.method })
          setChoosing(null)
        }}
      >
        {choosing?.method && (
          <p className="text-[0.9rem] leading-relaxed text-rd-text-2">
            {GLOSSARY[GLOSSARY_KEY[choosing.method]]?.detail}
            <br />
            相続放棄・限定承認は、家庭裁判所での手続き（申述）が必要です。ここでの記録はその代わりにはなりません。
            {choosing.method === 'LIMITED_ACCEPTANCE' && (
              <>
                <br />
                限定承認は、相続放棄をした方を除く相続人全員がそろって申し立てる必要があります。
              </>
            )}
            {choosing.method !== 'SIMPLE_ACCEPTANCE' && (
              <>
                <br />
                この方法を記録した方には、預金の解約など財産を動かす手続きを表示しません。
              </>
            )}
          </p>
        )}
      </Confirm>

      <Confirm
        open={deleting != null}
        title={`${deleting?.name ?? ''}さんの登録を削除しますか？`}
        confirmLabel="削除する"
        danger
        busy={del.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id)
          setDeleting(null)
        }}
      />

      {editing && (
        <PersonDialog caseId={caseId} person={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Page>
  )
}

function Avatar({ name, done }: { name: string; done?: boolean }) {
  return (
    <span
      className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-[0.94rem] font-bold ${
        done ? 'bg-rd-success-soft text-rd-success-text' : 'bg-rd-shade text-rd-text-2'
      }`}
    >
      {name.replace(/\s/g, '').slice(0, 1)}
      {done && (
        <span className="absolute -right-0.5 -bottom-0.5 grid h-4 w-4 place-items-center rounded-full bg-rd-success text-white">
          <Icon name="check" size={11} strokeWidth={3} />
        </span>
      )}
    </span>
  )
}

function PersonDialog({ caseId, person, onClose }: { caseId: string; person: Person | null; onClose: () => void }) {
  const create = useCreatePerson(caseId)
  const update = useUpdatePerson(caseId)
  const [name, setName] = useState(person?.name ?? '')
  const [relationship, setRelationship] = useState(person?.relationship ?? '')
  const [isHeir, setIsHeir] = useState(person?.isHeir ?? true)
  const [special, setSpecial] = useState(person?.specialCircumstance ?? '')
  const [contact, setContact] = useState(person?.contact ?? '')
  const [note, setNote] = useState(person?.note ?? '')

  return (
    <Confirm
      open
      title={person ? '登録内容を編集' : '家族・関係者を追加'}
      confirmLabel="保存する"
      busy={create.isPending || update.isPending}
      disabled={!name.trim()}
      onClose={onClose}
      onConfirm={async () => {
        const payload: Partial<Person> = {
          name: name.trim(),
          relationship: relationship.trim() || '—',
          role: isHeir ? 'HEIR_CANDIDATE' : 'RELATED',
          isHeir,
          specialCircumstance: (special || null) as Person['specialCircumstance'],
          contact: contact.trim() || undefined,
          note: note.trim() || undefined,
        }
        if (person) await update.mutateAsync({ id: person.id, ...payload })
        else await create.mutateAsync(payload)
        onClose()
      }}
    >
      <div className="flex flex-col gap-3.5">
        <Field label="お名前" required>
          {(id) => <input id={id} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="故人との続柄" hint="例：配偶者、長男、姪">
          {(id) => <input id={id} className={inputClass} value={relationship} onChange={(e) => setRelationship(e.target.value)} />}
        </Field>
        <Checkbox checked={isHeir} onChange={setIsHeir}>相続人になる可能性のある方として登録する</Checkbox>
        <Field label="特別な事情">
          {(id) => (
            <select id={id} className={inputClass} value={special} onChange={(e) => setSpecial(e.target.value)}>
              <option value="">特になし</option>
              {Object.entries(SPECIAL_CIRCUMSTANCE_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          )}
        </Field>
        {special && (
          <Notice tone="warning">
            {SPECIAL_CIRCUMSTANCE_META[special]?.hint} 法的な判断を伴うため、弁護士・司法書士へのご相談をおすすめします。
          </Notice>
        )}
        <Field label="連絡先" hint="ご本人以外の連絡先を登録するときは、ご本人の了解を得てください。">
          {(id) => <input id={id} className={inputClass} value={contact} onChange={(e) => setContact(e.target.value)} />}
        </Field>
        <Field label="メモ">
          {(id) => <input id={id} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Confirm>
  )
}
