/**
 * AI Server への配送口（仕様書 6.3・15.2）。
 *
 * Backend と AI は独立した Hono サービスで、相手の src や Repository を
 * import しない。やり取りは認証済みの内部 HTTP だけに限る。
 */
export interface AgentJob {
  /** 重複排除に使う。同じ ID の再配送を受信側が弾く。 */
  eventId: string
  tenantId: string
  caseId: string | null
  type: string
  payload: Record<string, unknown>
  /** 何回目の配送か。受信側の判断材料にする。 */
  attempt: number
}

export type AgentDeliveryOutcome =
  /** 受理された。重複として無視された場合も含む。 */
  | { status: 'ACCEPTED' }
  /** 受理されなかったが、時間をおけば成功しうる。 */
  | { status: 'RETRYABLE'; reason: string }
  /** 受理できない。再送しても同じ結果になる。 */
  | { status: 'REJECTED'; reason: string }

export interface AgentJobClient {
  deliver(job: AgentJob): Promise<AgentDeliveryOutcome>
}
