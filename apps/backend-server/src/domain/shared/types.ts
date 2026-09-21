export type ISODateTime = string

export type ActorKind = 'USER' | 'SYSTEM' | 'AI'

export interface ActorRef {
  kind: ActorKind
  id: string
}

/** Case 内で正式状態を持つエンティティの共通メタ */
export interface CaseEntity {
  id: string
  tenantId: string
  caseId: string
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
  createdBy: ActorRef
  updatedBy: ActorRef
}

/** 除外（一覧から外す）は完全削除とは区別する。除外後も参照解決のため記録は残す */
export interface Excludable {
  excludedAt: ISODateTime | null
  excludedBy: ActorRef | null
  exclusionReason: string | null
}

export function isExcluded(entity: Excludable): boolean {
  return entity.excludedAt !== null
}

export function touch<T extends CaseEntity>(entity: T, actor: ActorRef, now: ISODateTime): T {
  return { ...entity, version: entity.version + 1, updatedAt: now, updatedBy: actor }
}
