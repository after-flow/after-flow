/**
 * Outbox イベント（仕様書 15.2）。
 *
 * 業務変更と同じ Transaction で保存し、配送は別プロセスが行う。
 * HTTP 要求の後処理に配送をぶら下げると、プロセス再起動で消える。
 * 実際の配送・再配送・重複排除は #10 が実装する。
 */
export type OutboxStatus = 'PENDING' | 'IN_FLIGHT' | 'DELIVERED' | 'FAILED'

export interface OutboxEvent {
  /** 配送の重複排除キー。受信側はこの ID で冪等に処理する。 */
  id: string
  tenantId: string
  caseId: string | null
  type: string
  /** 配送先が解釈する内容。原本本文や資格情報は入れない。 */
  payload: Record<string, unknown>
  /**
   * この変更を起こした利用者。
   *
   * 配送時に同意 Policy を評価するために必要。要求本文の申告ではなく、
   * 認証済みの actor から記録する。
   */
  initiatedByUserId: string | null
  status: OutboxStatus
  attempts: number
  /** 配送claimの世代。遅着した旧workerの応答で状態を戻さない。 */
  claimId?: string
  leaseExpiresAt?: string
  /** 次に配送を試みる時刻。再試行の間隔制御に使う。 */
  nextAttemptAt: string
  /** 直近の失敗理由。運用が原因を追えるようにする。 */
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type NewOutboxEvent = Pick<OutboxEvent, 'type' | 'payload'> & {
  /** 指定しなければ保存側が採番する。再送時に同じ ID を使う場合だけ指定する。 */
  id?: string
  caseId?: string | null
}
