import type { EntityBase } from '../shared/entity.js'

/**
 * 企画書セクション 3 の 10 段階フロー。
 *
 * Domain 側で持つ。公開契約と同じ値だが、表示の都合で公開型が変わっても
 * 業務側の区分が引きずられないようにする。一致は schema 層で検証する。
 */
export type FlowStageId =
  | 'immediate'
  | 'funeral'
  | 'government'
  | 'contracts'
  | 'investigation'
  | 'decision'
  | 'division'
  | 'transfer'
  | 'tax'
  | 'closing'

export type TaskStatus =
  | 'NOT_STARTED'
  | 'COLLECTING_INFORMATION'
  | 'WAITING_DOCUMENTS'
  /** 申請の準備が整った。外部への提出はまだ。 */
  | 'READY'
  /** 本人が提出したと報告した。外部機関の受理確認ではない。 */
  | 'SUBMITTED'
  /** 提出後、外部機関の処理を待っている。 */
  | 'WAITING_EXTERNAL'
  | 'ACTION_REQUIRED'
  /** 手続きが完了した。準備完了や提出報告とは別。 */
  | 'COMPLETED'
  | 'ESCALATED'

export type TaskSource = 'MANUAL' | 'AI' | 'RULE_ENGINE'

export interface RequiredDocumentRef {
  id: string
  label: string
  documentId: string | null
  source: TaskSource
}

export interface TaskEntity extends EntityBase {
  title: string
  summary: string
  status: TaskStatus
  stage: FlowStageId
  category: string
  submitTo: string | null
  assigneeId: string | null
  source: TaskSource
  /** 初期手続きの重複生成を防ぐための定義 ID。手動作成では null。 */
  procedureId: string | null
  requiredDocuments: RequiredDocumentRef[]
  /**
   * 完了に根拠を要求するか。
   *
   * すべての Task に一律で書類添付を求めない。一般的な手動 ToDo は
   * 本人の報告で完了できる。
   */
  evidenceRequired: boolean
  /**
   * 財産処分・現金化に相当する手続き。
   *
   * 相続方法が確定するまで実行させない（放棄前ロック）。
   * 判定は Backend が行い、フロントの非表示に依存しない。
   */
  assetDisposal: boolean
  /** 完了を報告した利用者と日時。外部機関による確認ではない。 */
  completionReportedBy: string | null
  completionReportedAt: string | null
}
