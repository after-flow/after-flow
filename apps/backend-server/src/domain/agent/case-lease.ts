import type { EntityBase } from '../shared/entity.js'

/**
 * Case の書き込み権（仕様書 7.3）。
 *
 * 同じ Case へ複数の AI 実行が同時に書き込むと、互いの前提を壊す。
 * 書き込みを伴う実行は lease を取ってから行う。
 */
export interface CaseLeaseEntity extends EntityBase {
  /** lease を保持している実行。空いていれば null。 */
  holderRunId: string | null
  /**
   * 世代番号。
   *
   * lease を取り直すたびに増える。古い所有者が戻ってきても、
   * 小さい値の要求は拒否できる。期限だけで判定すると、時計のずれで
   * 二重の書き込みを許す。
   */
  fencingToken: number
  /** 失効時刻。過ぎた lease は他の実行が奪える。 */
  expiresAt: string | null
  acquiredAt: string | null
}

export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000

/** 失効しているか。境界は「期限に達したら失効」。 */
export function isLeaseExpired(lease: CaseLeaseEntity, now: number): boolean {
  if (lease.expiresAt === null) return true
  return Date.parse(lease.expiresAt) <= now
}

/** その実行が今も書き込んでよいか。 */
export function holdsLease(lease: CaseLeaseEntity, runId: string, now: number): boolean {
  return lease.holderRunId === runId && !isLeaseExpired(lease, now)
}
