import type {
  PersonRole,
  RelationshipKind,
  SpecialCircumstance,
} from '@aftercare/public-contracts'
import { referenced, validation } from '../shared/errors.js'
import { isExcluded, touch, type ActorRef, type CaseEntity, type Excludable, type ISODateTime } from '../shared/types.js'

export interface PersonFields {
  name: string
  nameKana: string | null
  /** 利用者が入力した続柄ラベル。法的判定ではない */
  relationshipLabel: string
  role: PersonRole
  /** 利用者申告。法定相続人の判定ではない */
  isHeir: boolean
  dateOfBirth: string | null
  specialCircumstance: SpecialCircumstance | null
  contact: string | null
  note: string | null
}

export interface Person extends CaseEntity, Excludable, PersonFields {}

export interface RelationshipFields {
  fromPersonId: string
  toPersonId: string
  kind: RelationshipKind
  note: string | null
}

export interface Relationship extends CaseEntity, Excludable, RelationshipFields {}

/** 除外可否判定に使う、他集約からの参照数 */
export interface PersonReferences {
  inheritanceDecisions: number
  evidences: number
  auditEntries: number
}

interface NewEntityMeta {
  id: string
  tenantId: string
  caseId: string
  actor: ActorRef
  now: ISODateTime
}

const NAME_MAX = 200
const NOTE_MAX = 2000

function validatePersonFields(fields: PersonFields): void {
  if (fields.name.trim().length === 0) throw validation('name は必須です', { field: 'name' })
  if (fields.name.length > NAME_MAX) throw validation('name が長すぎます', { field: 'name' })
  if (fields.relationshipLabel.length > NAME_MAX)
    throw validation('relationship が長すぎます', { field: 'relationship' })
  if ((fields.note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  if (fields.role === 'DECEASED' && fields.isHeir)
    throw validation('故人本人を相続人候補にはできません', { field: 'isHeir' })
}

export function createPerson(meta: NewEntityMeta, fields: PersonFields): Person {
  validatePersonFields(fields)
  return {
    id: meta.id,
    tenantId: meta.tenantId,
    caseId: meta.caseId,
    version: 1,
    createdAt: meta.now,
    updatedAt: meta.now,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    excludedAt: null,
    excludedBy: null,
    exclusionReason: null,
    ...fields,
  }
}

export function updatePerson(
  person: Person,
  patch: Partial<PersonFields>,
  actor: ActorRef,
  now: ISODateTime,
): Person {
  if (isExcluded(person)) throw validation('除外済みの関係者は訂正できません')
  const next: PersonFields = {
    name: patch.name ?? person.name,
    nameKana: patch.nameKana === undefined ? person.nameKana : patch.nameKana,
    relationshipLabel: patch.relationshipLabel ?? person.relationshipLabel,
    role: patch.role ?? person.role,
    isHeir: patch.isHeir ?? person.isHeir,
    dateOfBirth: patch.dateOfBirth === undefined ? person.dateOfBirth : patch.dateOfBirth,
    specialCircumstance:
      patch.specialCircumstance === undefined ? person.specialCircumstance : patch.specialCircumstance,
    contact: patch.contact === undefined ? person.contact : patch.contact,
    note: patch.note === undefined ? person.note : patch.note,
  }
  validatePersonFields(next)
  return touch({ ...person, ...next }, actor, now)
}

/**
 * 除外は一覧から外す操作。個人情報の削除ではなく、Decision/Evidence/Audit からの参照は保持する。
 * 相続方法の記録が残っている関係者は、先に Decision 側を整理しないと除外できない。
 */
export function excludePerson(
  person: Person,
  references: PersonReferences,
  reason: string | null,
  actor: ActorRef,
  now: ISODateTime,
): Person {
  if (isExcluded(person)) throw validation('すでに除外されています')
  if (references.inheritanceDecisions > 0) {
    throw referenced('相続方法の記録が紐づいているため除外できません。先に記録を見直してください', {
      inheritanceDecisions: references.inheritanceDecisions,
    })
  }
  return touch({ ...person, excludedAt: now, excludedBy: actor, exclusionReason: reason }, actor, now)
}

export function createRelationship(
  meta: NewEntityMeta,
  fields: RelationshipFields,
  from: Person,
  to: Person,
): Relationship {
  if (fields.fromPersonId === fields.toPersonId)
    throw validation('同一人物間の関係は登録できません', { field: 'toPersonId' })
  for (const p of [from, to]) {
    if (p.caseId !== meta.caseId || p.tenantId !== meta.tenantId)
      throw validation('関係の両端は同じCaseの関係者でなければなりません', { personId: p.id })
    if (isExcluded(p)) throw validation('除外済みの関係者に関係は登録できません', { personId: p.id })
  }
  if ((fields.note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  return {
    id: meta.id,
    tenantId: meta.tenantId,
    caseId: meta.caseId,
    version: 1,
    createdAt: meta.now,
    updatedAt: meta.now,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    excludedAt: null,
    excludedBy: null,
    exclusionReason: null,
    ...fields,
  }
}

export function updateRelationship(
  rel: Relationship,
  patch: Partial<Pick<RelationshipFields, 'kind' | 'note'>>,
  actor: ActorRef,
  now: ISODateTime,
): Relationship {
  if (isExcluded(rel)) throw validation('除外済みの関係は訂正できません')
  const note = patch.note === undefined ? rel.note : patch.note
  if ((note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  return touch({ ...rel, kind: patch.kind ?? rel.kind, note }, actor, now)
}

export function excludeRelationship(
  rel: Relationship,
  reason: string | null,
  actor: ActorRef,
  now: ISODateTime,
): Relationship {
  if (isExcluded(rel)) throw validation('すでに除外されています')
  return touch({ ...rel, excludedAt: now, excludedBy: actor, exclusionReason: reason }, actor, now)
}
