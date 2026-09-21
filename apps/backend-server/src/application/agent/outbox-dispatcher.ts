import { randomUUID } from 'node:crypto'
import { Timestamp, type Firestore } from '@google-cloud/firestore'
import { INFRASTRUCTURE_COLLECTIONS } from '../../domain/shared/collections.js'
import type { OutboxEvent } from '../../domain/shared/outbox.js'
import { logger } from '../../presentation/http/logger.js'
import type { ConsentService } from '../consent/consent-service.js'
import type { AgentJobClient, AgentDeliveryOutcome } from '../ports/agent-client.js'
import { assertValidId } from '../../infrastructure/firestore/paths.js'

export interface LocalOutboxHandler {
  types: ReadonlySet<string>
  deliverLocal(event: OutboxEvent): Promise<AgentDeliveryOutcome>
}

/**
 * Outbox の配送（仕様書 15.2）。
 *
 * 配送は少なくとも 1 回を前提にする。送信後・記録前にクラッシュしても
 * 同じ eventId で再配送し、受信側が重複を排除する。
 *
 * HTTP 要求の後処理に配送をぶら下げない。プロセスが落ちると未配送のまま
 * 消えるため、保存済みのイベントから独立して動かす。
 */
export interface DispatchResult {
  delivered: string[]
  retrying: string[]
  rejected: string[]
  blocked: string[]
}

/**
 * 同意の検査を通さないイベント。
 *
 * 個人データを含まず、処理を止めるために届ける必要があるもの。
 * 同意の撤回そのものを同意不足で止めると、AI 側は撤回を知れない。
 */
const CONTROL_EVENT_TYPES = new Set(['consent.revoked', 'agent.cancel'])

/** 再試行の間隔。回数に応じて伸ばし、上限で頭打ちにする。 */
export function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000)
}

export interface DeliveryGiveUp {
  /** 再試行を打ち切るまでの、イベント作成からの経過時間。未指定なら打ち切らない。 */
  deliveryTimeoutMs?: number
  /** 打ち切り時に業務側の状態を確定させる。Outbox を FAILED にする前に呼ぶ。 */
  onGiveUp?: (event: OutboxEvent, reason: string) => Promise<void>
}

export class OutboxDispatcher {
  constructor(
    private readonly firestore: Firestore,
    private readonly client: AgentJobClient,
    private readonly consent: ConsentService,
    /** 配送中とみなす時間。これを過ぎた IN_FLIGHT は再配送の対象になる。 */
    private readonly visibilityTimeoutMs = 2 * 60_000,
    private readonly local?: LocalOutboxHandler,
    private readonly giveUp: DeliveryGiveUp = {},
  ) {
    const timeout = giveUp.deliveryTimeoutMs
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= visibilityTimeoutMs)) {
      throw new Error('deliveryTimeoutMs must exceed the visibility timeout')
    }
  }

  /**
   * 配送できるイベントを 1 回分処理する。
   *
   * 定期実行の呼び出し側は別に用意する。ここでは 1 バッチだけを扱い、
   * 途中で落ちても次回の呼び出しで続きから進められるようにする。
   */
  async dispatchBatch(tenantId: string, limit = 20): Promise<DispatchResult> {
    assertValidId(tenantId, 'tenantId')
    const result: DispatchResult = { delivered: [], retrying: [], rejected: [], blocked: [] }
    const now = Date.now()

    const query = this.firestore
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('status', 'in', ['PENDING', 'IN_FLIGHT'])
      .orderBy('nextAttemptAt', 'asc')
    // 旧DispatcherはISO文字列、UnitOfWorkはTimestampを書いていたため両形式を読む。
    // 将来時刻のイベントがバッチ先頭を占有して、配送可能な後続を塞がない。
    const snapshots = await Promise.all([Timestamp.fromMillis(now), new Date(now).toISOString()]
      .map(time => query.where('nextAttemptAt', '<=', time).limit(limit).get()))
    const documents = [...new Map(snapshots.flatMap(s => s.docs).map(doc => [doc.id, doc])).values()]
      .sort((a, b) => toMillis(a.get('nextAttemptAt')) - toMillis(b.get('nextAttemptAt'))).slice(0, limit)

    for (const document of documents) {
      const event = document.data() as OutboxEvent
      const nextAttemptAt = toMillis(event.nextAttemptAt)
      if (nextAttemptAt > now) continue
      // 配送中のまま時間切れになったものだけを引き取る。
      if (event.status === 'IN_FLIGHT' && this.leaseExpiry(event) > now) continue

      const claimed = await this.claim(document.ref.path, Date.now())
      if (!claimed) continue

      // 外部 AI へ渡してよいかを配送のたびに確かめる。
      // 受付時に同意があっても、待機中に撤回されていることがある。
      try {
        if (!this.local?.types.has(claimed.type) && !(await this.isDeliveryAllowed(tenantId, claimed))) {
          if (await this.settle(document.ref.path, claimed, {
            status: 'PENDING', lastError: 'CONSENT_REQUIRED', nextAttemptAt: Timestamp.fromMillis(Date.now() + backoffMs(1)),
          })) result.blocked.push(claimed.id)
          continue
        }

        const outcome = this.local?.types.has(claimed.type) ? await this.local.deliverLocal(claimed) : await this.client.deliver({
          eventId: claimed.id,
          tenantId,
          caseId: claimed.caseId,
          type: claimed.type,
          payload: claimed.payload,
          attempt: claimed.attempts,
        })

        if (outcome.status === 'ACCEPTED') {
          if (await this.settle(document.ref.path, claimed, { status: 'DELIVERED', lastError: null })) result.delivered.push(claimed.id)
        } else if (outcome.status === 'RETRYABLE') {
          await this.retryOrGiveUp(document.ref.path, claimed, outcome.reason, result)
        } else {
          await this.giveUp.onGiveUp?.(claimed, outcome.reason)
          if (await this.settle(document.ref.path, claimed, { status: 'FAILED', lastError: outcome.reason })) result.rejected.push(claimed.id)
        }
      } catch {
        await this.retryOrGiveUp(document.ref.path, claimed, 'DELIVERY_EXCEPTION', result)
      }
    }

    return result
  }

  /**
   * 一時障害は指数バックオフで再送する。作成からの経過時間が上限を超えたら、
   * 業務側の状態を先に確定させてから Outbox を終端する。順序を逆にすると、
   * 途中で落ちた場合に Outbox だけが FAILED になり Run が QUEUED のまま残る。
   */
  private async retryOrGiveUp(path: string, claimed: OutboxEvent, reason: string, result: DispatchResult): Promise<void> {
    const timeout = this.giveUp.deliveryTimeoutMs
    const age = Date.now() - toMillis(claimed.createdAt)
    if (timeout !== undefined && age >= timeout) {
      const lastError = `DELIVERY_TIMEOUT:${reason}`
      await this.giveUp.onGiveUp?.(claimed, lastError)
      if (await this.settle(path, claimed, { status: 'FAILED', lastError })) result.rejected.push(claimed.id)
      return
    }
    if (await this.settle(path, claimed, { status: 'PENDING', lastError: reason,
      nextAttemptAt: Timestamp.fromMillis(Date.now() + backoffMs(claimed.attempts)),
    })) result.retrying.push(claimed.id)
  }

  /**
   * 1 件を自分の担当にする。
   *
   * 取得と状態更新を同じ Transaction で行い、複数のプロセスが
   * 同じイベントを同時に配送しないようにする。
   */
  private async claim(path: string, now: number): Promise<OutboxEvent | null> {
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(this.firestore.doc(path))
      if (!snapshot.exists) return null
      const event = snapshot.data() as OutboxEvent
      if (event.status === 'DELIVERED' || event.status === 'FAILED') return null
      // 一覧取得後に他workerがclaimした場合にも、Transaction内で期限を検証する。
      if (toMillis(event.nextAttemptAt) > now || (event.status === 'IN_FLIGHT' && this.leaseExpiry(event) > now)) return null

      const attempts = event.attempts + 1
      const claimId = randomUUID()
      const leaseExpiresAt = new Date(now + this.visibilityTimeoutMs).toISOString()
      transaction.update(this.firestore.doc(path), {
        status: 'IN_FLIGHT',
        attempts,
        claimId,
        leaseExpiresAt,
        nextAttemptAt: Timestamp.fromMillis(now + this.visibilityTimeoutMs),
        updatedAt: new Date(now).toISOString(),
      })
      return { ...event, attempts, claimId, leaseExpiresAt }
    })
  }

  private async isDeliveryAllowed(tenantId: string, event: OutboxEvent): Promise<boolean> {
    // SYSTEMが作るresume/recover。Scoped clientが保存済みRunの利用者をtransactionで再認可する。
    if (event.type === 'agent.resume' || event.type === 'agent.recover') return true
    // 処理を止めるための通知は、同意の有無に関わらず届ける。
    if (CONTROL_EVENT_TYPES.has(event.type)) return true
    if (!event.initiatedByUserId) {
      // 誰の操作か分からないイベントを外部 AI へ渡さない。
      return false
    }
    const decision = await this.consent.policy({ userId: event.initiatedByUserId, tenantId })
    return decision.externalAi
  }

  private leaseExpiry(event: OutboxEvent): number {
    return event.leaseExpiresAt ? toMillis(event.leaseExpiresAt) : toMillis(event.nextAttemptAt) + this.visibilityTimeoutMs
  }

  private async settle(path: string, claimed: OutboxEvent, patch: Record<string, unknown>): Promise<boolean> {
    return this.firestore.runTransaction(async tx => {
      const ref = this.firestore.doc(path)
      const current = await tx.get(ref)
      if (current.get('status') !== 'IN_FLIGHT' || current.get('claimId') !== claimed.claimId) return false
      tx.update(ref, { ...patch, updatedAt: Timestamp.now() })
      return true
    })
  }

  async backlog(tenantId: string): Promise<{ pending: number; failed: number; oldestAgeMs: number }> {
    assertValidId(tenantId, 'tenantId')
    const outbox = this.firestore.collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
    const pending = outbox.where('status', 'in', ['PENDING', 'IN_FLIGHT'])
    const [count, failures, oldest] = await Promise.all([
      pending.count().get(), outbox.where('status', '==', 'FAILED').count().get(),
      pending.orderBy('createdAt', 'asc').limit(1).get(),
    ])
    const oldestAgeMs = oldest.empty ? 0 : Math.max(0, Date.now() - toMillis(oldest.docs[0]!.get('createdAt')))
    const result = { pending: count.data().count, failed: failures.data().count, oldestAgeMs }
    if (oldestAgeMs > 15 * 60_000 || result.failed > 0) logger.warn('outbox backlog alert', { tenantId, ...result })
    return result
  }
}

/** 保存形式が Timestamp でも ISO 文字列でも扱えるようにする。 */
function toMillis(value: unknown): number {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate().getTime()
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}
