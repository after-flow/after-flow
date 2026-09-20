import type { AssetKind, LiabilityKind, RecordSource } from '@aftercare/public-contracts'
import { invalidTransition, validation } from '../shared/errors.js'
import { touch, type ActorRef, type CaseEntity, type ISODateTime } from '../shared/types.js'

/** 円単位の整数。不明は null（0 円と区別する） */
export type YenAmount = number | null
export const YEN_MAX_EXCLUSIVE = 1_000_000_000_000_000

export function validateYen(amount: YenAmount, field = 'amount'): void {
  if (amount === null) return
  if (!Number.isSafeInteger(amount)) throw validation('金額は円単位の整数で指定してください', { field })
  if (amount < 0 || amount >= YEN_MAX_EXCLUSIVE) throw validation('金額が範囲外です', { field })
}

export interface Confirmation {
  state: 'UNCONFIRMED' | 'CONFIRMED'
  confirmedAt: ISODateTime | null
  confirmedBy: ActorRef | null
  confirmedVersion: number | null
  note: string | null
}

export const UNCONFIRMED: Confirmation = {
  state: 'UNCONFIRMED',
  confirmedAt: null,
  confirmedBy: null,
  confirmedVersion: null,
  note: null,
}

/** 出自。公開APIからは MANUAL のみ。AI 由来は承認フロー（#11）で Backend が設定する */
export interface Provenance {
  source: RecordSource
  agentRunId: string | null
  proposalId: string | null
}

export const MANUAL_PROVENANCE: Provenance = { source: 'MANUAL', agentRunId: null, proposalId: null }

interface EstateItemBase extends CaseEntity {
  name: string
  amount: YenAmount
  currency: 'JPY'
  note: string | null
  provenance: Provenance
  confirmation: Confirmation
}

export interface Asset extends EstateItemBase {
  kind: AssetKind
  institution: string | null
  taxAttention: boolean
}

export interface Liability extends EstateItemBase {
  kind: LiabilityKind
  creditor: string | null
}

export interface AssetFields {
  name: string
  kind: AssetKind
  institution: string | null
  amount: YenAmount
  taxAttention: boolean
  note: string | null
}

export interface LiabilityFields {
  name: string
  kind: LiabilityKind
  creditor: string | null
  amount: YenAmount
  note: string | null
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

function validateCommon(name: string, amount: YenAmount, note: string | null): void {
  if (name.trim().length === 0) throw validation('name は必須です', { field: 'name' })
  if (name.length > NAME_MAX) throw validation('name が長すぎます', { field: 'name' })
  validateYen(amount)
  if ((note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
}

function baseOf(meta: NewEntityMeta): CaseEntity {
  return {
    id: meta.id,
    tenantId: meta.tenantId,
    caseId: meta.caseId,
    version: 1,
    createdAt: meta.now,
    updatedAt: meta.now,
    createdBy: meta.actor,
    updatedBy: meta.actor,
  }
}

export function createAsset(meta: NewEntityMeta, fields: AssetFields): Asset {
  validateCommon(fields.name, fields.amount, fields.note)
  return {
    ...baseOf(meta),
    ...fields,
    currency: 'JPY',
    provenance: MANUAL_PROVENANCE,
    confirmation: UNCONFIRMED,
  }
}

export function createLiability(meta: NewEntityMeta, fields: LiabilityFields): Liability {
  validateCommon(fields.name, fields.amount, fields.note)
  return {
    ...baseOf(meta),
    ...fields,
    currency: 'JPY',
    provenance: MANUAL_PROVENANCE,
    confirmation: UNCONFIRMED,
  }
}

/** 確認済みの値（名称・種別・相手先・金額）が変わったら確認は無効になる。note 等のメモは影響しない */
function confirmationAfterChange<T extends EstateItemBase>(before: T, after: T, factKeys: (keyof T)[]): Confirmation {
  if (before.confirmation.state !== 'CONFIRMED') return before.confirmation
  const changed = factKeys.some((k) => before[k] !== after[k])
  return changed ? UNCONFIRMED : before.confirmation
}

const ASSET_FACTS: (keyof Asset)[] = ['name', 'kind', 'institution', 'amount']
const LIABILITY_FACTS: (keyof Liability)[] = ['name', 'kind', 'creditor', 'amount']

export function updateAsset(asset: Asset, patch: Partial<AssetFields>, actor: ActorRef, now: ISODateTime): Asset {
  const merged: Asset = {
    ...asset,
    name: patch.name ?? asset.name,
    kind: patch.kind ?? asset.kind,
    institution: patch.institution === undefined ? asset.institution : patch.institution,
    amount: patch.amount === undefined ? asset.amount : patch.amount,
    taxAttention: patch.taxAttention ?? asset.taxAttention,
    note: patch.note === undefined ? asset.note : patch.note,
  }
  validateCommon(merged.name, merged.amount, merged.note)
  return touch({ ...merged, confirmation: confirmationAfterChange(asset, merged, ASSET_FACTS) }, actor, now)
}

export function updateLiability(
  liability: Liability,
  patch: Partial<LiabilityFields>,
  actor: ActorRef,
  now: ISODateTime,
): Liability {
  const merged: Liability = {
    ...liability,
    name: patch.name ?? liability.name,
    kind: patch.kind ?? liability.kind,
    creditor: patch.creditor === undefined ? liability.creditor : patch.creditor,
    amount: patch.amount === undefined ? liability.amount : patch.amount,
    note: patch.note === undefined ? liability.note : patch.note,
  }
  validateCommon(merged.name, merged.amount, merged.note)
  return touch(
    { ...merged, confirmation: confirmationAfterChange(liability, merged, LIABILITY_FACTS) },
    actor,
    now,
  )
}

/**
 * 利用者による確認の記録。金融機関等による外部確認や評価額の算定ではない。
 * 対象 version は Application 層で expectedVersion と照合済みであること。
 */
export function confirmEstateItem<T extends EstateItemBase>(
  item: T,
  note: string | null,
  actor: ActorRef,
  now: ISODateTime,
): T {
  if (item.confirmation.state === 'CONFIRMED') {
    throw invalidTransition('CONFIRMED', 'CONFIRMED', 'すでに確認済みです')
  }
  if ((note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  const confirmation: Confirmation = {
    state: 'CONFIRMED',
    confirmedAt: now,
    confirmedBy: actor,
    confirmedVersion: item.version,
    note,
  }
  return touch({ ...item, confirmation }, actor, now)
}
