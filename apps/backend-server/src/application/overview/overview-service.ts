import { listActiveHeirs } from '../decision/decision-service.js'
import type { Person } from '../../domain/person/person.js'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { CaseEntity } from '../../domain/case/case.js'
import { businessToday } from '../../domain/case/case-dates.js'
import { deliberationDeadlineOf } from '../../domain/decision/deliberation-period.js'
import type { InheritanceDecisionEntity } from '../../domain/decision/inheritance-decision.js'
import { isDecisionConfirmed } from '../../domain/decision/inheritance-decision.js'
import { collections } from '../../domain/shared/collections.js'
import type { DeadlineEntity } from '../../domain/task/deadline.js'
import type { BasisDates, RuleCatalog } from '../../domain/task/rule-engine.js'
import type { FlowStageId, TaskStatus } from '../../domain/task/task.js'
import { errors } from '../../shared/app-error.js'
import type { AgentRunView } from '../agent/agent-run-service.js'
import { toAgentRunView } from '../agent/agent-run-service.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CaseResource } from '@aftercare/public-contracts'
import { toCaseResource } from '../case/case-service.js'
import type { Clock } from '../ports.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { ReadRepository, SnapshotReader } from '../ports/persistence.js'
import type { DeadlineView } from '../task/task-service.js'
import { toDeadlineView } from '../task/task-service.js'

const TASK_STATUSES = [
  'NOT_STARTED',
  'COLLECTING_INFORMATION',
  'WAITING_DOCUMENTS',
  'READY',
  'SUBMITTED',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
  'COMPLETED',
  'ESCALATED',
] as const satisfies readonly TaskStatus[]

const DECISION_PAGE_SIZE = 200

/** 企画書セクション 3 の 10 段階。表示の順序をここで固定する。 */
const FLOW_STAGES: { id: FlowStageId; label: string }[] = [
  { id: 'immediate', label: '直後の手続き' },
  { id: 'funeral', label: '葬儀' },
  { id: 'government', label: '行政手続き' },
  { id: 'contracts', label: '契約の整理' },
  { id: 'investigation', label: '財産の調査' },
  { id: 'decision', label: '相続方法の決定' },
  { id: 'division', label: '遺産分割' },
  { id: 'transfer', label: '名義変更' },
  { id: 'tax', label: '税の申告' },
  { id: 'closing', label: '完了' },
]

export interface FlowStageView {
  id: FlowStageId
  label: string
  totalTasks: number
  completedTasks: number
  /**
   * 段階の状態。
   *
   * 対象の手続きが 0 件の段階は COMPLETED にしない。
   * 手続きが無いことと、終わったことは違う。
   */
  state: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_TASKS'
}

export interface DecisionSummaryView {
  personId: string
  /** Person の氏名。登録は #13。未登録の間は null。 */
  personName: string | null
  method: InheritanceDecisionEntity['method']
  state: InheritanceDecisionEntity['state']
  confirmed: boolean
}

export interface CaseOverviewView {
  case: CaseResource
  /** 全集計が共有するDB読取時点。caseVersionはCaseの業務版であり集約全体の版ではない。 */
  aggregatedAt: string
  consistency: 'SNAPSHOT'
  caseVersion: number
  taskCounts: Partial<Record<TaskStatus, number>>
  totalTasks: number
  flowStages: FlowStageView[]
  upcomingDeadlines: DeadlineView[]
  /** 期限を算定できていない件数。0 件でも「全部確定済み」を意味しない。 */
  unresolvedDeadlineCount: number
  pendingApprovalCount: number
  /** 業務状態へ反映済みの承認件数。承認の受付と反映を区別する。 */
  appliedApprovalCount: number
  inheritanceDecision: {
    /** 登録済みの相続人全員が本人として確定しているか。 */
    decided: boolean
    /** Person が未登録のため判定できない状態。 */
    unknown: boolean
    perHeir: DecisionSummaryView[]
    /**
     * 熟慮期間（民法915条）の期限。永続 Deadline ではなく、Case の日付から
     * 毎回その場で算定する（`domain/decision/deliberation-period.ts`）。
     * `id` は固定値 `deliberation-period`、`taskId` は常に null。
     * Task 側の期限（`inheritance-choice` ルール）と同じルールから算定する
     * ため、再評価後は必ず一致する（再評価前は一時的に不一致になりうる）。
     * カタログに `deliberationDeadlineRuleId` が無ければ null。
     */
    deliberationDeadline: DeadlineView | null
  }
  recentAgentRuns: AgentRunView[]
  /**
   * AI が接続されていないために活動が無いのか、活動が無いだけなのかを区別する。
   * 架空の活動履歴は返さない。
   */
  aiConnected: boolean
}

/**
 * ダッシュボードの集約（仕様書 6.2）。
 *
 * 一覧の 1 ページ目だけを数えない。Task と期限の件数は Firestore の
 * 集計クエリで求め、文書数が増えても途中で打ち切らない。
 */
export interface CaseOverviewServiceOptions {
  /** AI が接続されているか。未接続なら活動が無いことの理由になる。 */
  aiConnected?: boolean
  /** 「今日」の決め方。未指定なら実時刻。日付境界の試験で固定時刻を注入する。 */
  clock?: Clock
}

export class CaseOverviewService {
  private readonly aiConnected: boolean
  private readonly clock: Clock

  constructor(
    private readonly access: AccessService,
    private readonly read: SnapshotReader,
    /** 熟慮期間（3-4）を算定するための期限ルールカタログ。 */
    private readonly catalog: RuleCatalog,
    options: CaseOverviewServiceOptions = {},
  ) {
    this.aiConnected = options.aiConnected ?? false
    this.clock = options.clock ?? { now: () => new Date().toISOString() }
  }

  async get(user: AuthenticatedUser, caseId: string): Promise<CaseOverviewView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.read')
    return this.read.snapshot(user.tenantId, { collection: collections.cases, caseId: null, id: caseId },
      (read, readAt) => this.getSnapshot(user, caseId, access, read, readAt))
  }

  private async getSnapshot(user: AuthenticatedUser, caseId: string,
    access: Awaited<ReturnType<AccessService['authorizeCase']>>, read: ReadRepository,
    readAt: string): Promise<CaseOverviewView> {
    const caseEntity = await read.get<CaseEntity>(user.tenantId, {
      collection: collections.cases,
      caseId: null,
      id: caseId,
    })
    if (!caseEntity) throw errors.notFound()

    const [
      tasks,
      upcomingDeadlines,
      unresolvedDeadlineCount,
      decisions,
      heirs,
      runs,
      pendingApprovalCount,
      appliedApprovalCount,
    ] =
      await Promise.all([
        this.aggregateTasks(user, caseId, read),
        read.list<DeadlineEntity>(user.tenantId, collections.deadlines, caseId, {
          limit: 10,
          where: [{ field: 'dueDate', op: '>=', value: '' }],
          orderBy: { field: 'dueDate', direction: 'asc' },
        }),
        read.count(user.tenantId, collections.deadlines, caseId, [
          { field: 'dueDate', op: '==', value: null },
        ]),
        this.listAllDecisions(user.tenantId, caseId, read),
        listActiveHeirs(read, user.tenantId, caseId),
        read.list<AgentRunEntity>(user.tenantId, collections.agentRuns, caseId, {
          limit: 10,
          orderBy: { field: 'createdAt', direction: 'desc' },
        }),
        // 件数は集計クエリで数える。1 ページ目の長さを件数にしない。
        read.count(user.tenantId, collections.approvals, caseId, [
          { field: 'status', op: '==', value: 'PENDING' },
        ]),
        read.count(user.tenantId, collections.approvals, caseId, [
          { field: 'applicationStatus', op: '==', value: 'APPLIED' },
        ]),
      ])

    const today = businessToday(new Date(this.clock.now()))
    const upcoming = upcomingDeadlines.items.map((entity) => toDeadlineView(entity, today))
    const dates: BasisDates = { dateOfDeath: caseEntity.dateOfDeath, knownAt: caseEntity.knownAt }
    const deliberationFacts = deliberationDeadlineOf(this.catalog, dates)

    return {
      case: toCaseResource(caseEntity, access),
      aggregatedAt: readAt,
      consistency: 'SNAPSHOT',
      caseVersion: caseEntity.caseVersion,
      taskCounts: tasks.counts,
      totalTasks: tasks.total,
      flowStages: this.buildFlowStages(tasks.byStage),
      upcomingDeadlines: upcoming,
      // 算定できていない期限の存在を隠さない。
      unresolvedDeadlineCount,
      pendingApprovalCount,
      appliedApprovalCount,
      inheritanceDecision: {
        ...this.buildDecisionSummary(decisions, heirs),
        // 熟慮期間はupcomingDeadlines/unresolvedDeadlineCountの集計に含めない
        // （永続 Deadline の集計であり、その場算定のここを二重に数えない）。
        deliberationDeadline: deliberationFacts ? toDeadlineView(deliberationFacts, today) : null,
      },
      recentAgentRuns: runs.items.map(toAgentRunView),
      aiConnected: this.aiConnected,
    }
  }

  /** Task 本体を読み出さず、状態別・段階別の正確な件数を集計する。 */
  private async aggregateTasks(
    user: AuthenticatedUser,
    caseId: string,
    read: ReadRepository,
  ): Promise<{
    counts: Partial<Record<TaskStatus, number>>
    byStage: Map<FlowStageId, { total: number; completed: number; notStarted: number }>
    total: number
  }> {
    const counts: Partial<Record<TaskStatus, number>> = {}
    const byStage = new Map<FlowStageId, { total: number; completed: number; notStarted: number }>()

    const [statusCounts, stageCounts] = await Promise.all([
      Promise.all(
        TASK_STATUSES.map(async (status) => ({
          status,
          count: await read.count(user.tenantId, collections.tasks, caseId, [
            { field: 'status', op: '==', value: status },
          ]),
        })),
      ),
      Promise.all(
        FLOW_STAGES.map(async (stage) => {
          const [total, completed, notStarted] = await Promise.all([
            read.count(user.tenantId, collections.tasks, caseId, [
              { field: 'stage', op: '==', value: stage.id },
            ]),
            read.count(user.tenantId, collections.tasks, caseId, [
              { field: 'stage', op: '==', value: stage.id },
              { field: 'status', op: '==', value: 'COMPLETED' },
            ]),
            read.count(user.tenantId, collections.tasks, caseId, [
              { field: 'stage', op: '==', value: stage.id },
              { field: 'status', op: '==', value: 'NOT_STARTED' },
            ]),
          ])
          return { stage: stage.id, total, completed, notStarted }
        }),
      ),
    ])

    let total = 0
    for (const entry of statusCounts) {
      total += entry.count
      // 公開契約では 0 件の状態を省略できる。
      if (entry.count > 0) counts[entry.status] = entry.count
    }
    for (const entry of stageCounts) {
      byStage.set(entry.stage, { total: entry.total, completed: entry.completed, notStarted: entry.notStarted })
    }

    return { counts, byStage, total }
  }

  private async listAllDecisions(
    tenantId: string,
    caseId: string,
    read: ReadRepository,
  ): Promise<InheritanceDecisionEntity[]> {
    const decisions: InheritanceDecisionEntity[] = []
    let cursor: string | undefined

    do {
      const page = await read.list<InheritanceDecisionEntity>(
        tenantId,
        collections.decisions,
        caseId,
        { limit: DECISION_PAGE_SIZE, cursor },
      )
      decisions.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)

    return decisions
  }

  private buildFlowStages(
    byStage: Map<FlowStageId, { total: number; completed: number; notStarted: number }>,
  ): FlowStageView[] {
    return FLOW_STAGES.map((stage) => {
      const counts = byStage.get(stage.id) ?? { total: 0, completed: 0, notStarted: 0 }
      let state: FlowStageView['state']
      if (counts.total === 0) {
        // 対象の手続きが無い段階を完了にしない。
        state = 'NO_TASKS'
      } else if (counts.completed === counts.total) {
        state = 'COMPLETED'
      } else if (counts.notStarted < counts.total) {
        state = 'IN_PROGRESS'
      } else {
        state = 'NOT_STARTED'
      }
      return {
        id: stage.id,
        label: stage.label,
        totalTasks: counts.total,
        completedTasks: counts.completed,
        state,
      }
    })
  }

  /**
   * 相続方法の確定状況。
   *
   * 記録が 1 件も無い状態を確定済みにしない。method が入っているだけ、
   * 他人が報告しただけでも確定にしない。
   */
  private buildDecisionSummary(
    decisions: InheritanceDecisionEntity[],
    heirs: Person[],
  ): Omit<CaseOverviewView['inheritanceDecision'], 'deliberationDeadline'> {
    const byPerson = new Map(decisions.map(decision => [decision.personId, decision]))
    const perHeir: DecisionSummaryView[] = heirs.map(person => {
      const decision = byPerson.get(person.id)
      return {
        personId: person.id,
        personName: person.name,
        method: decision?.method ?? null,
        state: decision?.state ?? 'DRAFT',
        confirmed: decision ? isDecisionConfirmed(decision) : false,
      }
    })

    return {
      decided: perHeir.length > 0 && perHeir.every((entry) => entry.confirmed),
      // 相続人が未登録なら、確定しているかどうかを判定できない。
      unknown: perHeir.length === 0,
      perHeir,
    }
  }
}
