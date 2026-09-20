import type { Firestore } from '@google-cloud/firestore'
import { INFRASTRUCTURE_COLLECTIONS } from '../../domain/shared/collections.js'
import type { OutboxEvent } from '../../domain/shared/outbox.js'
import { logger } from '../../presentation/http/logger.js'
import type { ConsentService } from '../consent/consent-service.js'
import type { AgentJobClient } from '../ports/agent-client.js'

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
const CONTROL_EVENT_TYPES = new Set(['consent.revoked'])

/** 再試行の間隔。回数に応じて伸ばし、上限で頭打ちにする。 */
export function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000)
}

export class OutboxDispatcher {
  constructor(
    private readonly firestore: Firestore,
    private readonly client: AgentJobClient,
    private readonly consent: ConsentService,
    /** 配送中とみなす時間。これを過ぎた IN_FLIGHT は再配送の対象になる。 */
    private readonly visibilityTimeoutMs = 2 * 60_000,
  ) {}

  /**
   * 配送できるイベントを 1 回分処理する。
   *
   * 定期実行の呼び出し側は別に用意する。ここでは 1 バッチだけを扱い、
   * 途中で落ちても次回の呼び出しで続きから進められるようにする。
   */
  async dispatchBatch(tenantId: string, limit = 20): Promise<DispatchResult> {
    const result: DispatchResult = { delivered: [], retrying: [], rejected: [], blocked: [] }
    const now = Date.now()

    const snapshot = await this.firestore
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('status', 'in', ['PENDING', 'IN_FLIGHT'])
      .orderBy('nextAttemptAt', 'asc')
      .limit(limit)
      .get()

    for (const document of snapshot.docs) {
      const event = document.data() as OutboxEvent
      const nextAttemptAt = toMillis(event.nextAttemptAt)
      if (nextAttemptAt > now) continue
      // 配送中のまま時間切れになったものだけを引き取る。
      if (event.status === 'IN_FLIGHT' && nextAttemptAt + this.visibilityTimeoutMs > now) continue

      const claimed = await this.claim(document.ref.path, now)
      if (!claimed) continue

      // 外部 AI へ渡してよいかを配送のたびに確かめる。
      // 受付時に同意があっても、待機中に撤回されていることがある。
      if (!(await this.isDeliveryAllowed(tenantId, claimed))) {
        await this.markBlocked(document.ref.path)
        result.blocked.push(claimed.id)
        continue
      }

      const outcome = await this.client.deliver({
        eventId: claimed.id,
        tenantId,
        caseId: claimed.caseId,
        type: claimed.type,
        payload: claimed.payload,
        attempt: claimed.attempts,
      })

      if (outcome.status === 'ACCEPTED') {
        await this.markDelivered(document.ref.path)
        result.delivered.push(claimed.id)
      } else if (outcome.status === 'RETRYABLE') {
        await this.scheduleRetry(document.ref.path, claimed.attempts, outcome.reason)
        result.retrying.push(claimed.id)
      } else {
        await this.markFailed(document.ref.path, outcome.reason)
        result.rejected.push(claimed.id)
      }
    }

    return result
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

      const attempts = event.attempts + 1
      transaction.update(this.firestore.doc(path), {
        status: 'IN_FLIGHT',
        attempts,
        nextAttemptAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })
      return { ...event, attempts }
    })
  }

  private async isDeliveryAllowed(tenantId: string, event: OutboxEvent): Promise<boolean> {
    // 処理を止めるための通知は、同意の有無に関わらず届ける。
    if (CONTROL_EVENT_TYPES.has(event.type)) return true
    if (!event.initiatedByUserId) {
      // 誰の操作か分からないイベントを外部 AI へ渡さない。
      return false
    }
    const decision = await this.consent.policy({ userId: event.initiatedByUserId, tenantId })
    return decision.externalAi
  }

  private async markDelivered(path: string): Promise<void> {
    await this.firestore.doc(path).update({
      status: 'DELIVERED',
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
  }

  private async markBlocked(path: string): Promise<void> {
    // 同意が無い間は配送しない。失敗ではないので PENDING へ戻す。
    await this.firestore.doc(path).update({
      status: 'PENDING',
      lastError: 'external AI delivery is not permitted by the current consent',
      nextAttemptAt: new Date(Date.now() + backoffMs(1)).toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  private async scheduleRetry(path: string, attempts: number, reason: string): Promise<void> {
    await this.firestore.doc(path).update({
      status: 'PENDING',
      lastError: reason,
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  private async markFailed(path: string, reason: string): Promise<void> {
    logger.warn('outbox delivery rejected', { path, reason })
    await this.firestore.doc(path).update({
      status: 'FAILED',
      lastError: reason,
      updatedAt: new Date().toISOString(),
    })
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
