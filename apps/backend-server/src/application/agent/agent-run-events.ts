import { randomUUID } from 'node:crypto'
import type { AgentRunEntity, AgentRunStatus } from '../../domain/agent/agent-run.js'
import type { AgentRunEventEntity, AgentRunEventKind } from '../../domain/agent/agent-run-event.js'
import { collections } from '../../domain/shared/collections.js'
import type { DocLocation, Tx } from '../ports/persistence.js'
import { fingerprintOf } from '../../shared/fingerprint.js'

/**
 * 公開可能なRun履歴の記録（Issue #125）。
 *
 * 呼び出し側の業務transactionの内側でだけ使う。対象RunのEntity変更・監査・
 * outboxと同じtransactionで確定するため、イベントとRun状態は原子的に整合する。
 * この関数の外でHTTP/LLM/Queue/Storage I/Oを行わないこと。
 */

function eventLocation(caseId: string, runId: string, eventId: string): DocLocation {
  // ID は [A-Za-z0-9_-] のみ許される（documentPath の検査）。runId:eventId を
  // そのまま連結すると eventId 側の区切り文字次第で壊れるため、指紋にする。
  // runId を含めるのは、Case内の複数Runにまたがるeventの衝突を避けるため。
  return { collection: collections.agentRunEvents, caseId, id: fingerprintOf({ runId, eventId }) }
}

export interface RecordAgentRunEventInput {
  caseId: string
  runId: string
  kind: AgentRunEventKind
  status: AgentRunStatus
  attempt: number
  /**
   * Run内の発生順として使う版。
   *
   * 同じtransaction内でRun Entityへ加える tx.create/tx.update に渡す
   * バージョン（expectedVersion、または新規作成時の1）の次の値と同じにする。
   * Run Entityはこの一覧に無い理由でも版が進むため連番ではないが、
   * 同じRunの2つの行が同じ値を取らないことは保証する。
   */
  sequence: number
  /** 省略時はBackendが新規に発行する。AI由来の呼び出しは元のeventId/resultIdを渡す。 */
  eventId?: string
  detail?: Record<string, unknown>
}

/**
 * 同じeventIdの再送では新しい行を作らない（完了条件: 重複イベントを作らない）。
 * 呼び出し側のtransactionが既に同じ結果を返す設計（内部APIのreceipt、または
 * 公開APIのIdempotency-Key）であっても、この関数単体でも冪等に振る舞う。
 */
export async function recordAgentRunEvent(tx: Tx, input: RecordAgentRunEventInput): Promise<void> {
  const eventId = input.eventId ?? randomUUID()
  const location = eventLocation(input.caseId, input.runId, eventId)
  const existing = await tx.get<AgentRunEventEntity>(location)
  if (existing) return
  tx.create<AgentRunEventEntity>(location, {
    id: location.id,
    runId: input.runId,
    eventId,
    kind: input.kind,
    status: input.status,
    attempt: input.attempt,
    sequence: input.sequence,
    detail: input.detail ?? {},
  })
}

/** accept直後、Run Entity作成と同じtransactionで呼ぶ。新規作成なのでversionは常に1。 */
export function recordAcceptedEvent(tx: Tx, caseId: string, runId: string, detail: Record<string, unknown>) {
  return recordAgentRunEvent(tx, { caseId, runId, kind: 'ACCEPTED', status: 'QUEUED', attempt: 1, sequence: 1, detail })
}

/** run.versionを進めるtx.updateと同じtransactionで呼ぶ。sequenceはその更新後の版。 */
export function recordRunTransitionEvent(
  tx: Tx,
  run: Pick<AgentRunEntity, 'caseId' | 'id' | 'version' | 'attempt'>,
  kind: AgentRunEventKind,
  status: AgentRunStatus,
  options: { eventId?: string; attempt?: number; detail?: Record<string, unknown> } = {},
) {
  if (!run.caseId) return Promise.resolve()
  return recordAgentRunEvent(tx, {
    caseId: run.caseId, runId: run.id, kind, status,
    attempt: options.attempt ?? run.attempt, sequence: run.version + 1,
    eventId: options.eventId, detail: options.detail,
  })
}
