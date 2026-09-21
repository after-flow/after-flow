import type { AgentRunResource } from './agent.js'
import type { CaseResource } from './case.js'
import type { DeadlineResource, TaskStatusResource } from './task.js'
import type { DecisionStateResource, InheritanceMethodResource } from './proposal.js'
import type { FlowStageId, ISODateTime } from './resources.js'

/**
 * 新しい公開契約のダッシュボード集約。
 *
 * 既存の `CaseOverview` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

export interface FlowStageResource {
  id: FlowStageId
  label: string
  totalTasks: number
  completedTasks: number
  /**
   * 段階の状態。
   * 対象の手続きが0件の段階は NO_TASKS であり、完了ではない。
   * 表示があることは、その段階の手続きを網羅している保証ではない。
   */
  state: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_TASKS'
}

export interface DecisionSummaryResource {
  personId: string
  /** 氏名。関係者の登録に依存し、未登録の間は null。 */
  personName: string | null
  method: InheritanceMethodResource | null
  state: DecisionStateResource
  confirmed: boolean
}

export interface CaseOverviewResource {
  case: CaseResource
  /** 集約全体が共有するDB読取時点。 */
  aggregatedAt: ISODateTime
  consistency: 'SNAPSHOT'
  /** Caseの業務版。Task/Run/Approval等を含む集約全体の版ではない。 */
  caseVersion: number
  taskCounts: Partial<Record<TaskStatusResource, number>>
  totalTasks: number
  flowStages: FlowStageResource[]
  upcomingDeadlines: DeadlineResource[]
  /** 期限を算定できていない件数。0件でも全部確定済みを意味しない。 */
  unresolvedDeadlineCount: number
  pendingApprovalCount: number
  /** 業務状態へ反映済みの承認件数。承認の受付と反映を区別する。 */
  appliedApprovalCount: number
  inheritanceDecision: {
    /** 登録済みの相続人全員が本人として確定しているか。 */
    decided: boolean
    /** 関係者が未登録のため判定できない状態。 */
    unknown: boolean
    perHeir: DecisionSummaryResource[]
    /**
     * 熟慮期間（民法915条）の期限。`id` は固定値 `deliberation-period`、
     * `taskId` は常に null。Task 側の期限（相続方法の選択）と同じルールから
     * 算定するため、再評価後は必ず一致する（再評価前は一時的に不一致になりうる）。
     * カタログに熟慮期間のルールが無ければ null。
     */
    deliberationDeadline: DeadlineResource | null
  }
  recentAgentRuns: AgentRunResource[]
  /** AIが接続されているか。活動が無い理由を区別するために返す。 */
  aiConnected: boolean
}
