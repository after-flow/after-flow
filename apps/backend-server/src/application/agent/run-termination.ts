import { randomUUID } from 'node:crypto'
import type { AgentRunEntity, AgentRunStatus } from '../../domain/agent/agent-run.js'
import { collections } from '../../domain/shared/collections.js'
import type { GuidanceEntity } from '../../domain/task/guidance.js'
import type { Tx } from '../ports/persistence.js'

const runLocation = (caseId: string, id: string) => ({ collection: collections.agentRuns, caseId, id })
const guidanceLocation = (caseId: string, taskId: string) => ({ collection: collections.guidance, caseId, id: taskId })

export interface GuidanceFailure {
  failureReason: string
  /** 失敗した試行。取消では世代を変える前の値を渡す。 */
  attemptId: string | null
  resultId?: string | null
  note?: string | null
  missing?: string[]
}

/**
 * Runが終端・要確認になったとき、Task側の案内を同じTransactionで揃える。
 * 別のRunに置き換えられた案内、既に確定した案内は触らない。
 */
export async function failGuidanceForRun(tx: Tx, caseId: string, run: AgentRunEntity, failure: GuidanceFailure): Promise<boolean> {
  if (run.operation !== 'task_guidance' || run.targetType !== 'TASK') return false
  const location = guidanceLocation(caseId, run.targetId)
  const current = await tx.get<GuidanceEntity>(location)
  if (!current || current.agentRunId !== run.id) return false
  if (current.status !== 'RESEARCHING' && current.status !== 'WAITING') return false
  tx.update<GuidanceEntity>(location, current.version, {
    status: 'FAILED',
    failureReason: failure.failureReason,
    note: failure.note ?? current.note,
    missing: failure.missing ?? current.missing,
    resultId: failure.resultId ?? current.resultId,
    attemptId: failure.attemptId,
  })
  tx.audit({
    caseId,
    type: 'guidance.failed',
    target: { collection: collections.guidance.name, id: run.targetId, version: current.version + 1 },
    detail: { runId: run.id, failureReason: failure.failureReason },
  })
  return true
}

export interface RunTermination {
  status: Extract<AgentRunStatus, 'FAILED' | 'NEEDS_ATTENTION'>
  failureReason: string
  auditType: string
  detail?: Record<string, unknown>
  /** 未開始の旧配送が後から到着しても実行できないようattempt世代を更新する。 */
  rotateAttempt?: boolean
}

/** 配送できなかったQUEUEDのRunを終端させる。実行中のRunはlease/snapshot経由で別に扱う。 */
export async function terminateQueuedRun(tx: Tx, caseId: string, run: AgentRunEntity, termination: RunTermination): Promise<void> {
  const failedAttemptId = run.currentAttemptId
  await failGuidanceForRun(tx, caseId, run, { failureReason: termination.failureReason, attemptId: failedAttemptId })
  tx.update<AgentRunEntity>(runLocation(caseId, run.id), run.version, {
    status: termination.status,
    failureReason: termination.failureReason,
    finishedAt: new Date().toISOString(),
    ...(termination.rotateAttempt ? { currentAttemptId: randomUUID() } : {}),
  })
  tx.audit({
    caseId,
    type: termination.auditType,
    target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 },
    detail: { failureReason: termination.failureReason, ...termination.detail },
  })
}
