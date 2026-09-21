import type { FlowStageId, ISODate, ISODateTime } from './resources.js'

/**
 * 新しい公開契約の手続きと期限。
 *
 * 既存の `Task` / `DeadlineSummary` はモックのフロントが参照しているため
 * 変更しない。旧 DTO への変換は Web の公開クライアント境界で行う（#3）。
 */

export type TaskStatusResource =
  | 'NOT_STARTED'
  | 'COLLECTING_INFORMATION'
  | 'WAITING_DOCUMENTS'
  /** 申請の準備が整った。外部への提出はまだ。 */
  | 'READY'
  /** 本人が提出したと報告した。外部機関の受理確認ではない。 */
  | 'SUBMITTED'
  | 'WAITING_EXTERNAL'
  | 'ACTION_REQUIRED'
  /** 手続きが完了した。準備完了や提出報告とは別。 */
  | 'COMPLETED'
  | 'ESCALATED'

/** 状態を変える操作。status の直接指定は受け付けない。 */
export type TaskCommandResource =
  | 'start'
  | 'requestDocuments'
  | 'markReady'
  | 'reportSubmission'
  | 'awaitExternal'
  | 'complete'
  | 'reopen'
  | 'flagActionRequired'
  | 'escalate'

/** 操作が許されない理由。 */
export type TaskBlockedReasonResource =
  | 'INVALID_TRANSITION'
  | 'EVIDENCE_REQUIRED'
  | 'INHERITANCE_DECISION_REQUIRED'
  | 'INSUFFICIENT_ROLE'
  | 'DEPENDENCY_NOT_COMPLETED'

export type DeadlineConfirmationResource = 'CONFIRMED' | 'UNCONFIRMED'

/** 期限を算定できない理由。 */
export type DeadlineUnresolvedReasonResource = 'MISSING_BASIS_DATE' | 'RULE_UNCONFIRMED'

export interface DeadlineResource {
  id: string
  taskId: string | null
  label: string
  /** 起算日と根拠の説明。Rule Engine が生成した文字列をそのまま表示する。 */
  basisLabel: string
  startDate: ISODate | null
  /**
   * 算定した期限。
   * 業務レビュー未了のルールや起算日が未入力の場合は null になる。
   * 推測した日付を確定した期限として表示させない。
   */
  dueDate: ISODate | null
  daysRemaining: number | null
  severity: 'NORMAL' | 'SOON' | 'URGENT' | 'OVERDUE' | null
  confirmation: DeadlineConfirmationResource
  unresolvedReason: DeadlineUnresolvedReasonResource | null
  jurisdiction: string
  /** 日付境界の解釈に用いた時間帯。 */
  timezone: string
  ruleId: string
  ruleVersion: string
  sourceUrl: string | null
  sourceCheckedAt: ISODateTime | null
  extendable: boolean | null
  critical: boolean
}

export interface TaskEvidenceResource {
  id: string
  label: string
  kind: 'RECEIPT' | 'NOTICE' | 'PAYMENT' | 'REGISTRATION' | 'OTHER'
  note: string | null
  recordedAt: ISODateTime
}

/** submitTo の出所。洗い出しが上書きしてよいのは RULE のときだけ。 */
export type SubmitToSourceResource = 'RULE' | 'RESEARCH' | 'MANUAL'

export interface TaskRequiredDocumentResource {
  id: string
  label: string
  documentId: string | null
  source: 'MANUAL' | 'AI' | 'RULE_ENGINE'
}

export interface TaskResource {
  id: string
  caseId: string
  title: string
  summary: string
  status: TaskStatusResource
  stage: FlowStageId
  category: string
  submitTo: string | null
  /** 手続き定義 ID。null は未マッピング（AI 案内の Context 投影に使わない）。 */
  procedureId: string | null
  /** 同じCaseに属する、除外されていない関係者のID。権限付与ではない。 */
  assigneeId: string | null
  dependencyTaskIds: string[]
  escalation: { proposalId: string; reason: string; documents: { id: string; version: number }[]; contacted: false } | null
  source: 'MANUAL' | 'AI' | 'RULE_ENGINE'
  /** 完了に根拠の登録を要するか。 */
  evidenceRequired: boolean
  /** 財産処分に相当するか。相続方法の確定まで実行できない。 */
  assetDisposal: boolean
  requiredDocuments: TaskRequiredDocumentResource[]
  /** 本人が完了を報告した記録。外部機関による確認ではない。 */
  completionReportedBy: string | null
  completionReportedAt: ISODateTime | null
  deadline: DeadlineResource | null
  /** 「わからない」「未回答」であてはまる可能性ありとして残している手続き。手動・AI 由来は常に false。 */
  conditional: boolean
  submitToSource: SubmitToSourceResource | null
  /**
   * 法定期限ではない目安の期限（申し送り 11-1）。永続しない、その場算定の値。
   * `id` は `target:` 接頭辞を持つ。`ruleId` は熟慮期間ルールを継承するので、
   * 種別の判定には `ruleId` ではなく `id` の接頭辞を使うこと。critical は常に false。
   */
  targetDate: DeadlineResource | null
  evidences: TaskEvidenceResource[]
  /** いま実行できる操作。フロントは自前で判定しない。 */
  allowedActions: TaskCommandResource[]
  blockedActions: { action: TaskCommandResource; reason: TaskBlockedReasonResource }[]
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}
