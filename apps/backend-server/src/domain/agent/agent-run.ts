import type { AgentRunOutcomeResource } from '@aftercare/public-contracts'
import type { EntityBase } from '../shared/entity.js'
import type { GuidanceOutcome } from '../task/guidance.js'

/**
 * AI 実行の業務記録（仕様書 6.3・11.3）。
 *
 * 受付・権限・結果表示の正本。AI Server 側の Workflow Snapshot とは別で、
 * 片方をもう片方の全面コピーとして扱わない。
 */

/**
 * 実行状態。
 *
 * 待機と失敗を RUNNING / SUCCEEDED の二択へ圧縮しない。
 * 「書類待ち」と「承認待ち」と「再試行待ち」は利用者に別の行動を促す。
 */
export type AgentRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  /** 必要な書類が揃うまで待っている。 */
  | 'WAITING_DOCUMENT'
  /** 人による承認を待っている。 */
  | 'WAITING_APPROVAL'
  /** 失敗したが、時間をおいて再試行する予定がある。 */
  | 'RETRY_SCHEDULED'
  /** 自動では進められない。利用者の確認が要る。 */
  | 'NEEDS_ATTENTION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'

/** 公開する業務操作。任意の Agent・モデル・Prompt・URL は指定させない。 */
export type AgentOperation =
  | 'document_analysis'
  | 'case_planning'
  | 'task_guidance'
  | 'chat_reply'

export interface AgentRunEntity extends EntityBase {
  cancellation?: { cancelId: string; jobId: string; executionAttempt: string }
  outcome?: AgentRunOutcomeResource | null
  /** task_guidanceの構造化終了理由。legacy/他操作では欠落する。 */
  guidanceOutcome?: GuidanceOutcome | null
  clarificationHistory?: { resultId: string; questionIndex: number; question: string; answer: string; caseVersion: number; state: 'user_reported' }[]
  operation: AgentOperation
  status: AgentRunStatus
  /** 実行の対象。保存済みの Run から scope を導出し、要求本文を信用しない。 */
  targetType: 'CASE' | 'TASK' | 'DOCUMENT' | 'MESSAGE'
  targetId: string
  /** 受け付けた時点の Case 版。結果の鮮度判定に使う。 */
  caseVersionAtAccept: number
  /** 実行を開始した回数。retry ごとに増える。 */
  attempt: number
  /** 直近の attempt の識別子。古い attempt の結果を弾くために使う。 */
  currentAttemptId: string
  /** 新契約で受け付けたRunに必須。旧データは内部APIでfail closed。 */
  initiatedByUserId?: string
  currentJobId?: string
  heartbeatAt?: string
  progressSequence?: number
  /** 現在の実行区間のlease世代。retry/resumeで破棄し、取り直す。 */
  fencingToken?: number | null
  /** 実行中のクラッシュとsuspend済み再開を区別するBackend所有の対応表。 */
  pendingResume?: { waitRequestId: string | null; snapshotId: string | null; previousAttemptId: string;
    kind: 'WAIT' | 'CHECKPOINT' | 'RETRY'; outcome: string } | null
  activeWaitRequestId?: string | null
  /** 失敗理由。利用者に見せてよい範囲。 */
  failureReason: string | null
  /** 待機の理由。status が WAITING_* のときに入る。 */
  waitingFor: string | null
  startedAt: string | null
  finishedAt: string | null
  /** 取消を要求した利用者。取消は実行の中止であり、確定済みの変更は戻さない。 */
  cancelRequestedBy: string | null
}

const TERMINAL: AgentRunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED']

export function isRunTerminal(status: AgentRunStatus): boolean {
  return TERMINAL.includes(status)
}

/** 待機中かどうか。待機は失敗ではない。 */
export function isRunWaiting(status: AgentRunStatus): boolean {
  return status === 'WAITING_DOCUMENT' || status === 'WAITING_APPROVAL' || status === 'RETRY_SCHEDULED'
}

/** 再試行できるのは、確定した失敗か注意が必要な状態のときだけ。 */
export function canRetry(status: AgentRunStatus): boolean {
  return status === 'FAILED' || status === 'NEEDS_ATTENTION'
}

export function canCancel(status: AgentRunStatus): boolean {
  return !isRunTerminal(status)
}
