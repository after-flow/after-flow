import type { ISODateTime } from './resources.js'

/**
 * 新しい公開契約の AI 実行。
 *
 * 既存の `AgentRunSummary` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

/**
 * 実行状態。
 *
 * 待機と失敗を RUNNING / SUCCEEDED の二択へ圧縮しない。
 * 「書類待ち」「承認待ち」「再試行待ち」は利用者に別の行動を促す。
 */
export type AgentRunStatusResource =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_DOCUMENT'
  | 'WAITING_APPROVAL'
  | 'RETRY_SCHEDULED'
  | 'NEEDS_ATTENTION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'

/** 受け付ける業務操作。任意のAgent・モデル・Prompt・URLは指定できない。 */
export type AgentOperationResource =
  | 'document_analysis'
  | 'case_planning'
  | 'task_guidance'
  | 'chat_reply'

/** AI narrative and questions; not confirmed business facts. */
export interface AgentRunOutcomeResource {
  resultId: string
  attemptId: string
  caseVersion: number
  summary: string
  completed: string[]
  questions: string[]
  remaining: string[]
}

/**
 * AgentRun進捗イベント（仕様書 6.2, Issue #125）。
 *
 * 受付・処理中・待機・再開・完了の履歴を時系列で示す。
 * prompt・非公開の思考・資格情報・原本文は含めない。`detail` は
 * 列挙値やIDなど安全な範囲の付随情報のみ。
 */
export type AgentRunEventKindResource =
  | 'ACCEPTED'
  | 'PROGRESS'
  | 'WAITING'
  | 'RESUMED'
  | 'RESULT'
  | 'CANCELLED'
  | 'RETRIED'

export interface AgentRunEventResource {
  id: string
  runId: string
  eventId: string
  kind: AgentRunEventKindResource
  status: AgentRunStatusResource
  attempt: number
  /** Run内の発生順。厳密な昇順（欠番はあり得る）。 */
  sequence: number
  detail: Record<string, unknown>
  occurredAt: ISODateTime
}

export interface AgentRunResource {
  id: string
  caseId: string
  operation: AgentOperationResource
  status: AgentRunStatusResource
  targetType: 'CASE' | 'TASK' | 'DOCUMENT' | 'MESSAGE'
  targetId: string
  attempt: number
  /** 待機中か。待機は失敗ではない。 */
  waiting: boolean
  waitingFor: string | null
  failureReason: string | null
  outcome: AgentRunOutcomeResource | null
  /** 受付時点のCase版。結果の鮮度判定に使う。 */
  caseVersionAtAccept: number
  startedAt: ISODateTime | null
  finishedAt: ISODateTime | null
  /** いま実行できる操作。 */
  allowedActions: ('cancel' | 'retry')[]
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}
