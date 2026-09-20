import type { CaseLeaseEntity } from '../../domain/agent/case-lease.js'
import { DEFAULT_LEASE_DURATION_MS, isLeaseExpired } from '../../domain/agent/case-lease.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, ReadRepository, UnitOfWork, WorkContext } from '../ports/persistence.js'

/** Case ごとに 1 つだけ。固定 ID にして取り合いを 1 文書に集約する。 */
const LEASE_DOCUMENT_ID = 'writer'

function leaseLocation(caseId: string): DocLocation {
  return { collection: collections.caseLeases, caseId, id: LEASE_DOCUMENT_ID }
}

export interface LeaseGrant {
  runId: string
  fencingToken: number
  expiresAt: string
}

/**
 * Case の書き込み権（仕様書 7.3）。
 *
 * 同じ Case への書き込みを伴う AI 実行を直列化する。
 * 期限だけで判定すると時計のずれで二重書き込みを許すため、
 * 取り直すたびに増える世代番号（fencingToken）を併用する。
 */
export class CaseLeaseService {
  constructor(
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    private readonly durationMs: number = DEFAULT_LEASE_DURATION_MS,
  ) {}

  async acquire(context: WorkContext, caseId: string, runId: string): Promise<LeaseGrant> {
    const now = Date.now()
    const expiresAt = new Date(now + this.durationMs).toISOString()

    return this.uow.run(context, async (tx) => {
      const current = await tx.get<CaseLeaseEntity>(leaseLocation(caseId))

      if (!current) {
        tx.create<CaseLeaseEntity>(leaseLocation(caseId), {
          id: LEASE_DOCUMENT_ID,
          holderRunId: runId,
          fencingToken: 1,
          expiresAt,
          acquiredAt: new Date(now).toISOString(),
        })
        return { runId, fencingToken: 1, expiresAt }
      }

      const heldByOther =
        current.holderRunId !== null && current.holderRunId !== runId && !isLeaseExpired(current, now)
      if (heldByOther) {
        throw errors.conflict({
          message: 'この案件では別の処理が実行中です。',
          details: { holderRunId: current.holderRunId, expiresAt: current.expiresAt },
        })
      }

      // 奪う場合も自分で取り直す場合も世代を進める。
      // 進めないと、失効前の所有者の書き込みを後から見分けられない。
      const fencingToken = current.fencingToken + 1
      tx.update<CaseLeaseEntity>(leaseLocation(caseId), current.version, {
        holderRunId: runId,
        fencingToken,
        expiresAt,
        acquiredAt: new Date(now).toISOString(),
      })
      return { runId, fencingToken, expiresAt }
    })
  }

  async renew(context: WorkContext, caseId: string, grant: LeaseGrant): Promise<LeaseGrant> {
    const now = Date.now()
    const expiresAt = new Date(now + this.durationMs).toISOString()

    return this.uow.run(context, async (tx) => {
      const current = await tx.require<CaseLeaseEntity>(leaseLocation(caseId))
      this.assertCurrentHolder(current, grant, now)
      tx.update<CaseLeaseEntity>(leaseLocation(caseId), current.version, { expiresAt })
      return { ...grant, expiresAt }
    })
  }

  async release(context: WorkContext, caseId: string, grant: LeaseGrant): Promise<void> {
    await this.uow.run(context, async (tx) => {
      const current = await tx.get<CaseLeaseEntity>(leaseLocation(caseId))
      if (!current) return
      // 期限切れで他所へ渡った lease を、古い所有者が解放しない。
      if (current.holderRunId !== grant.runId || current.fencingToken !== grant.fencingToken) return
      tx.update<CaseLeaseEntity>(leaseLocation(caseId), current.version, {
        holderRunId: null,
        expiresAt: null,
      })
    })
  }

  /**
   * いまも書き込んでよいかを確かめる。
   *
   * 古い世代の要求は、たとえ期限内に見えても拒否する。
   */
  async assertHolder(user: AuthenticatedUser, caseId: string, grant: LeaseGrant): Promise<void> {
    const current = await this.read.get<CaseLeaseEntity>(user.tenantId, leaseLocation(caseId))
    if (!current) throw errors.conflict({ message: 'この案件の実行権が確認できません。' })
    this.assertCurrentHolder(current, grant, Date.now())
  }

  private assertCurrentHolder(lease: CaseLeaseEntity, grant: LeaseGrant, now: number): void {
    if (lease.fencingToken !== grant.fencingToken || lease.holderRunId !== grant.runId) {
      throw errors.conflict({
        message: 'この処理の実行権は既に失効しています。',
        details: { reason: 'STALE_FENCING_TOKEN' },
      })
    }
    if (isLeaseExpired(lease, now)) {
      throw errors.conflict({
        message: 'この処理の実行権は期限切れです。',
        details: { reason: 'LEASE_EXPIRED' },
      })
    }
  }
}
