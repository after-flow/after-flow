import type {
  BenefitKind,
  ContractKind,
  ContractPolicy,
  ContractProgress,
  ProgressSource,
  TaskGuidance,
} from '@aftercare/public-contracts'
import { MANUAL_PROVENANCE, validateYen, type Provenance, type YenAmount } from '../estate/estate-item.js'
import { invalidTransition, validation } from '../shared/errors.js'
import { touch, type ActorRef, type CaseEntity, type ISODateTime } from '../shared/types.js'

/** 方針は利用者の意向の記録。解約・名義変更の実行や外部への通知は行わない */
export interface PolicyState {
  policy: ContractPolicy
  decidedAt: ISODateTime | null
  decidedBy: ActorRef | null
  note: string | null
}

/** 進捗は原則 USER_REPORTED（自己申告）。COMPLETED も外部確認を意味しない */
export interface ProgressState {
  progress: ContractProgress
  reportedAt: ISODateTime | null
  reportedBy: ActorRef | null
  source: ProgressSource | null
  note: string | null
}

export const UNDECIDED_POLICY: PolicyState = { policy: 'UNDECIDED', decidedAt: null, decidedBy: null, note: null }
export const NOT_STARTED_PROGRESS: ProgressState = {
  progress: 'NOT_STARTED',
  reportedAt: null,
  reportedBy: null,
  source: null,
  note: null,
}

export interface Contract extends CaseEntity {
  name: string
  kind: ContractKind
  provider: string | null
  note: string | null
  provenance: Provenance
  /** AI 提案の承認（#11）で付与。公開APIからは編集不可 */
  guidance: TaskGuidance | null
  policyState: PolicyState
  progressState: ProgressState
}

export interface Benefit extends CaseEntity {
  name: string
  kind: BenefitKind
  provider: string | null
  amount: YenAmount
  currency: 'JPY'
  note: string | null
  provenance: Provenance
  progressState: ProgressState
}

export interface ContractFields {
  name: string
  kind: ContractKind
  provider: string | null
  note: string | null
}

export interface BenefitFields {
  name: string
  kind: BenefitKind
  provider: string | null
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

function validateText(name: string, note: string | null): void {
  if (name.trim().length === 0) throw validation('name は必須です', { field: 'name' })
  if (name.length > NAME_MAX) throw validation('name が長すぎます', { field: 'name' })
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

export function createContract(meta: NewEntityMeta, fields: ContractFields): Contract {
  validateText(fields.name, fields.note)
  return {
    ...baseOf(meta),
    ...fields,
    provenance: MANUAL_PROVENANCE,
    guidance: null,
    policyState: UNDECIDED_POLICY,
    progressState: NOT_STARTED_PROGRESS,
  }
}

export function createBenefit(meta: NewEntityMeta, fields: BenefitFields): Benefit {
  validateText(fields.name, fields.note)
  validateYen(fields.amount)
  return {
    ...baseOf(meta),
    ...fields,
    currency: 'JPY',
    provenance: MANUAL_PROVENANCE,
    progressState: NOT_STARTED_PROGRESS,
  }
}

export function updateContract(
  contract: Contract,
  patch: Partial<ContractFields>,
  actor: ActorRef,
  now: ISODateTime,
): Contract {
  const merged: Contract = {
    ...contract,
    name: patch.name ?? contract.name,
    kind: patch.kind ?? contract.kind,
    provider: patch.provider === undefined ? contract.provider : patch.provider,
    note: patch.note === undefined ? contract.note : patch.note,
  }
  validateText(merged.name, merged.note)
  return touch(merged, actor, now)
}

export function updateBenefit(benefit: Benefit, patch: Partial<BenefitFields>, actor: ActorRef, now: ISODateTime): Benefit {
  const merged: Benefit = {
    ...benefit,
    name: patch.name ?? benefit.name,
    kind: patch.kind ?? benefit.kind,
    provider: patch.provider === undefined ? benefit.provider : patch.provider,
    amount: patch.amount === undefined ? benefit.amount : patch.amount,
    note: patch.note === undefined ? benefit.note : patch.note,
  }
  validateText(merged.name, merged.note)
  validateYen(merged.amount)
  return touch(merged, actor, now)
}

/**
 * 方針の変更。同じ方針への変更と、手続き完了後の変更は拒否する。
 * CANCEL は「解約予定」を記録するだけで、実際の解約ではない。
 */
export function setContractPolicy(
  contract: Contract,
  policy: ContractPolicy,
  note: string | null,
  actor: ActorRef,
  now: ISODateTime,
): Contract {
  const current = contract.policyState.policy
  if (current === policy) throw invalidTransition(current, policy, 'すでにその方針です')
  if (contract.progressState.progress === 'COMPLETED') {
    throw invalidTransition(current, policy, '手続き完了後に方針は変更できません。進捗を訂正してください')
  }
  if ((note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  return touch(
    { ...contract, policyState: { policy, decidedAt: now, decidedBy: actor, note } },
    actor,
    now,
  )
}

const PROGRESS_ORDER: Record<ContractProgress, number> = { NOT_STARTED: 0, CONTACTED: 1, COMPLETED: 2 }

/**
 * 進捗の自己申告。前進は自由、後退は訂正として note 必須、同一状態は拒否。
 * source は常に USER_REPORTED（外部確認・準備完了は別経路で記録する）。
 */
function nextProgress(
  state: ProgressState,
  progress: ContractProgress,
  note: string | null,
  actor: ActorRef,
  now: ISODateTime,
): ProgressState {
  const current = state.progress
  if (current === progress) throw invalidTransition(current, progress, 'すでにその進捗です')
  if (PROGRESS_ORDER[progress] < PROGRESS_ORDER[current] && !note?.trim()) {
    throw invalidTransition(current, progress, '進捗を戻す場合は理由（note）が必要です')
  }
  if ((note?.length ?? 0) > NOTE_MAX) throw validation('note が長すぎます', { field: 'note' })
  return { progress, reportedAt: now, reportedBy: actor, source: 'USER_REPORTED', note }
}

export function reportContractProgress(
  contract: Contract,
  progress: ContractProgress,
  note: string | null,
  actor: ActorRef,
  now: ISODateTime,
): Contract {
  if (progress === 'COMPLETED' && contract.policyState.policy === 'UNDECIDED') {
    throw invalidTransition(contract.progressState.progress, progress, '方針が未決定のまま完了にはできません')
  }
  return touch(
    { ...contract, progressState: nextProgress(contract.progressState, progress, note, actor, now) },
    actor,
    now,
  )
}

export function reportBenefitProgress(
  benefit: Benefit,
  progress: ContractProgress,
  note: string | null,
  actor: ActorRef,
  now: ISODateTime,
): Benefit {
  return touch(
    { ...benefit, progressState: nextProgress(benefit.progressState, progress, note, actor, now) },
    actor,
    now,
  )
}
