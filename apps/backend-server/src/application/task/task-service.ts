import { createHash, randomUUID } from 'node:crypto'
import type { Person } from '../../domain/person/person.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import type { DocumentEntity } from '../../domain/document/document.js'
import type { CaseEntity } from '../../domain/case/case.js'
import type {
  DeadlineEntity,
  DeadlineSeverity,
  DeadlineUnresolvedReason,
} from '../../domain/task/deadline.js'
import type { EvidenceEntity, EvidenceKind } from '../../domain/task/evidence.js'
import type { BasisDates, RuleCatalog } from '../../domain/task/rule-engine.js'
import { RULE_TIMEZONE, computeDeadline, daysRemaining, severityOf } from '../../domain/task/rule-engine.js'
import type { FlowStageId, TaskEntity, TaskStatus } from '../../domain/task/task.js'
import type { TaskCommand } from '../../domain/task/transitions.js'
import { ALL_TASK_COMMANDS, isAllowedTransition, targetStatus } from '../../domain/task/transitions.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService, CaseAccess } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, Page, ReadRepository, Tx, UnitOfWork } from '../ports/persistence.js'
import { SERVER_TIME } from '../ports/persistence.js'

/**
 * 本人の意思確定の状況を読む。
 *
 * 確定そのものは #11 が実装する。ここでは「確定しているか」だけを
 * 参照し、未実装の間は未確定として扱う。未確定を確定とみなすと、
 * 放棄前ロックが外れる。
 */
export interface InheritanceDecisionReader {
  isConfirmed(tenantId: string, caseId: string): Promise<boolean>
}

/** Decision が未実装の間の既定。確定していないものとして扱う。 */
export const UNDECIDED_INHERITANCE: InheritanceDecisionReader = {
  isConfirmed: async () => false,
}

interface TaskReferencesInput {
  assigneeId?: string | null
  dependencyTaskIds?: string[]
  requiredDocuments?: { id: string; label: string; documentId: string | null }[]
}

export interface CreateTaskInput extends TaskReferencesInput {
  title: string
  summary: string
  stage: FlowStageId
  category: string
  submitTo?: string | null
  evidenceRequired?: boolean
  assetDisposal?: boolean
}

export interface UpdateTaskInput extends TaskReferencesInput {
  title?: string
  summary?: string
  submitTo?: string | null
}

export interface DeadlineView {
  id: string
  taskId: string | null
  label: string
  basisLabel: string
  startDate: string | null
  dueDate: string | null
  daysRemaining: number | null
  severity: DeadlineSeverity | null
  /** 業務レビュー済みのルールから算定したか。 */
  confirmation: 'CONFIRMED' | 'UNCONFIRMED'
  unresolvedReason: DeadlineUnresolvedReason | null
  jurisdiction: string
  timezone: string
  ruleId: string
  ruleVersion: string
  sourceUrl: string | null
  sourceCheckedAt: string | null
  extendable: boolean | null
  critical: boolean
}

/** 操作が許されない理由。フロントはこれを見て導線を出し分ける。 */
export type TaskBlockedReason =
  | 'INVALID_TRANSITION'
  | 'EVIDENCE_REQUIRED'
  | 'INHERITANCE_DECISION_REQUIRED'
  | 'INSUFFICIENT_ROLE'
  | 'DEPENDENCY_NOT_COMPLETED'

export interface TaskView {
  id: string
  caseId: string
  title: string
  summary: string
  status: TaskStatus
  stage: FlowStageId
  category: string
  submitTo: string | null
  assigneeId: string | null
  dependencyTaskIds: string[]
  escalation: NonNullable<TaskEntity['escalation']> | null
  source: TaskEntity['source']
  evidenceRequired: boolean
  assetDisposal: boolean
  requiredDocuments: TaskEntity['requiredDocuments']
  completionReportedBy: string | null
  completionReportedAt: string | null
  deadline: DeadlineView | null
  evidences: { id: string; label: string; kind: EvidenceKind; note: string | null; recordedAt: string }[]
  /** いま実行できる操作。 */
  allowedActions: TaskCommand[]
  /** 実行できない操作とその理由。 */
  blockedActions: { action: TaskCommand; reason: TaskBlockedReason }[]
  version: number
  createdAt: string
  updatedAt: string
}

function taskLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.tasks, caseId, id }
}

function deadlineLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.deadlines, caseId, id }
}

function evidenceLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.evidence, caseId, id }
}

/**
 * 初期手続きの Task ID を定義から決める。
 *
 * Case 作成イベントが二重に届いても、同じ ID を指すため重複しない。
 */
function initialTaskId(caseId: string, procedureId: string): string {
  return createHash('sha256').update(`${caseId.length}:${caseId}/${procedureId}`).digest('hex').slice(0, 32)
}

function todayInRuleTimezone(): string {
  // 算定と表示の基準を実行環境の時間帯に依存させない。
  return new Intl.DateTimeFormat('en-CA', { timeZone: RULE_TIMEZONE }).format(new Date())
}

export class TaskService {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    private readonly decisions: InheritanceDecisionReader = UNDECIDED_INHERITANCE,
  ) {}

  /**
   * Case 作成から初期手続きを生成する。
   *
   * 直接呼び出しでも試験できるようにしてある。汎用の Outbox 配送との
   * 統合は #10 が担当する。
   */
  async generateInitialTasks(
    user: AuthenticatedUser,
    caseId: string,
    meta: CommandMeta,
  ): Promise<{ created: string[] }> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const created = await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
      const created: string[] = []
      const caseEntity = await tx.require<CaseEntity>({
        collection: collections.cases,
        caseId: null,
        id: caseId,
      })
      const dates: BasisDates = { dateOfDeath: caseEntity.dateOfDeath, knownAt: caseEntity.knownAt }

      for (const procedure of this.catalog.initialProcedures) {
        const taskId = initialTaskId(caseId, procedure.id)
        const existing = await tx.get<TaskEntity>(taskLocation(caseId, taskId))
        // 同じ定義から二度作らない。Case 作成の再送でも増えない。
        if (existing) continue

        tx.create<TaskEntity>(taskLocation(caseId, taskId), {
          id: taskId,
          title: procedure.title,
          summary: procedure.summary,
          status: 'NOT_STARTED',
          stage: procedure.stage,
          category: procedure.category,
          submitTo: procedure.submitTo,
          assigneeId: null,
          source: 'RULE_ENGINE',
          procedureId: procedure.id,
          requiredDocuments: procedure.requiredDocuments.map((document) => ({
            ...document,
            documentId: null,
            source: 'RULE_ENGINE' as const,
          })),
          evidenceRequired: procedure.evidenceRequired,
          assetDisposal: procedure.assetDisposal,
          completionReportedBy: null,
          completionReportedAt: null,
        })
        created.push(taskId)

        if (procedure.deadlineRuleId) {
          this.createDeadline(tx, caseId, taskId, procedure.deadlineRuleId, dates)
        }
      }

      if (created.length > 0) {
        tx.audit({
          caseId,
          type: 'task.initial_generated',
          target: { collection: collections.tasks.name, id: caseId, version: null },
          detail: { count: created.length, placeholderRules: this.catalog.placeholder },
        })
      }
      return created
    })

    return { created }
  }

  private createDeadline(
    tx: Tx,
    caseId: string,
    taskId: string,
    ruleId: string,
    dates: BasisDates,
  ): void {
    const rule = this.catalog.deadlineRules.find((candidate) => candidate.id === ruleId)
    if (!rule) {
      throw errors.internal({ internal: { reason: 'unknown deadline rule', ruleId } })
    }
    const computed = computeDeadline(rule, dates)
    const deadlineId = initialTaskId(caseId, `deadline:${ruleId}:${taskId}`)

    tx.create<DeadlineEntity>(deadlineLocation(caseId, deadlineId), {
      id: deadlineId,
      taskId,
      label: rule.label,
      basis: rule.basis,
      startDate: computed.startDate,
      dueDate: computed.dueDate,
      basisLabel: computed.basisLabel,
      jurisdiction: rule.jurisdiction,
      timezone: RULE_TIMEZONE,
      ruleId: rule.id,
      ruleVersion: rule.version,
      // レビュー未了のルールから算定した値を確定扱いにしない。
      confirmation: rule.reviewed ? 'CONFIRMED' : 'UNCONFIRMED',
      unresolvedReason: computed.unresolvedReason,
      sourceUrl: rule.sourceUrl,
      sourceCheckedAt: rule.sourceCheckedAt,
      extendable: rule.extendable,
      critical: rule.critical,
    })
  }

  /**
   * 起算日の変更に伴う期限の再評価。
   *
   * 死亡日や「知った日」が訂正されたとき、影響する期限を版付きで
   * 作り直す。古い算定結果を残すと、画面は訂正前の期限を表示し続ける。
   */
  async reevaluateDeadlines(
    user: AuthenticatedUser,
    caseId: string,
    meta: CommandMeta,
  ): Promise<{ updated: string[] }> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const updated: string[] = []

    let cursor: string | undefined
    do {
      const page = await this.read.list<DeadlineEntity>(user.tenantId, collections.deadlines, caseId, {
        limit: 100, cursor, orderBy: { field: 'createdAt', direction: 'asc' },
      })
      const changed = await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
        const changed: string[] = []
        const caseEntity = await tx.require<CaseEntity>({
          collection: collections.cases,
          caseId: null,
          id: caseId,
        })
        const dates: BasisDates = { dateOfDeath: caseEntity.dateOfDeath, knownAt: caseEntity.knownAt }

        for (const stored of page.items) {
          const rule = this.catalog.deadlineRules.find((candidate) => candidate.id === stored.ruleId)
          if (!rule) continue
          const computed = computeDeadline(rule, dates)
          const current = await tx.require<DeadlineEntity>(deadlineLocation(caseId, stored.id))
          if (computed.dueDate === current.dueDate && computed.startDate === current.startDate
            && rule.version === current.ruleVersion && current.confirmation === (rule.reviewed ? 'CONFIRMED' : 'UNCONFIRMED')) continue
          tx.update<DeadlineEntity>(deadlineLocation(caseId, stored.id), current.version, {
            startDate: computed.startDate,
            dueDate: computed.dueDate,
            basisLabel: computed.basisLabel,
            unresolvedReason: computed.unresolvedReason,
            ruleVersion: rule.version,
            confirmation: rule.reviewed ? 'CONFIRMED' : 'UNCONFIRMED',
          })
          changed.push(stored.id)
        }

        if (changed.length > 0) {
          tx.audit({
            caseId,
            type: 'deadline.reevaluated',
            target: { collection: collections.deadlines.name, id: caseId, version: null },
            detail: { count: changed.length },
          })
        }
        return changed
      })
      updated.push(...changed)
      cursor = page.nextCursor
    } while (cursor)

    return { updated }
  }

  async create(
    user: AuthenticatedUser,
    caseId: string,
    input: CreateTaskInput,
    meta: CommandMeta,
  ): Promise<TaskView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const taskId = randomUUID()

    const storedId = await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      await this.validateReferences(tx, caseId, taskId, input)
      tx.create<TaskEntity>(taskLocation(caseId, taskId), {
        id: taskId,
        title: input.title,
        summary: input.summary,
        status: 'NOT_STARTED',
        stage: input.stage,
        category: input.category,
        submitTo: input.submitTo ?? null,
        assigneeId: input.assigneeId ?? null,
        dependencyTaskIds: input.dependencyTaskIds ?? [],
        source: 'MANUAL',
        procedureId: null,
        requiredDocuments: (input.requiredDocuments ?? []).map(ref => ({ ...ref, source: 'MANUAL' })),
        evidenceRequired: input.evidenceRequired ?? false,
        assetDisposal: input.assetDisposal ?? false,
        completionReportedBy: null,
        completionReportedAt: null,
      })
      tx.audit({
        caseId,
        type: 'task.created',
        target: { collection: collections.tasks.name, id: taskId, version: 1 },
        detail: { source: 'MANUAL' },
      })
      return taskId
    })

    return this.view(user, access, caseId, storedId)
  }

  async list(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<TaskView>> {
    const access = await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<TaskEntity>(user.tenantId, collections.tasks, caseId, {
      limit: options.limit,
      cursor: options.cursor,
    })
    const items = await Promise.all(
      page.items.map((entity) => this.viewOf(user, access, caseId, entity)),
    )
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  async get(user: AuthenticatedUser, caseId: string, taskId: string): Promise<TaskView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.read')
    return this.view(user, access, caseId, taskId)
  }

  /** 説明の訂正。状態は変更しない。 */
  async update(
    user: AuthenticatedUser,
    caseId: string,
    taskId: string,
    expectedVersion: number,
    input: UpdateTaskInput,
    meta: CommandMeta,
  ): Promise<TaskView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<TaskEntity>(taskLocation(caseId, taskId))
      if (current.version !== expectedVersion) throw errors.conflict()
      await this.validateReferences(tx, caseId, taskId, input)
      const patch: Partial<TaskEntity> = {}
      if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId
      if (input.dependencyTaskIds !== undefined) patch.dependencyTaskIds = input.dependencyTaskIds
      if (input.requiredDocuments !== undefined) {
        patch.requiredDocuments = input.requiredDocuments.map(ref => ({ ...ref, source: 'MANUAL' }))
      }
      if (current.status === 'COMPLETED' && (input.dependencyTaskIds || input.requiredDocuments)) {
        throw errors.preconditionFailed({ details: { reason: 'REOPEN_REQUIRED' } })
      }
      if (input.title !== undefined && input.title !== current.title) patch.title = input.title
      if (input.summary !== undefined && input.summary !== current.summary) patch.summary = input.summary
      if (input.submitTo !== undefined && (input.submitTo ?? null) !== current.submitTo) {
        patch.submitTo = input.submitTo ?? null
      }
      if (Object.keys(patch).length === 0) return

      tx.update<TaskEntity>(taskLocation(caseId, taskId), expectedVersion, patch)
      tx.audit({
        caseId,
        type: 'task.updated',
        target: { collection: collections.tasks.name, id: taskId, version: expectedVersion + 1 },
        detail: { changed: Object.keys(patch) },
      })
    })

    return this.view(user, access, caseId, taskId)
  }

  /**
   * 状態を変える唯一の入口。
   *
   * status の直接指定を受け付けず、遷移表と完了条件を必ず通す。
   */
  async runCommand(
    user: AuthenticatedUser,
    caseId: string,
    taskId: string,
    command: TaskCommand,
    expectedVersion: number,
    meta: CommandMeta,
    options: { note?: string | null } = {},
  ): Promise<TaskView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<TaskEntity>(taskLocation(caseId, taskId))

      if (this.requiresDependencies(command)) {
        for (const id of current.dependencyTaskIds ?? []) {
          const dependency = await tx.require<TaskEntity>(taskLocation(caseId, id))
          if (dependency.status !== 'COMPLETED') {
            throw errors.preconditionFailed({ details: { reason: 'DEPENDENCY_NOT_COMPLETED', taskId: id } })
          }
        }
      }

      if (!isAllowedTransition(command, current.status)) {
        throw errors.preconditionFailed({
          message: 'いまの状態ではこの操作を実行できません。',
          details: { reason: 'INVALID_TRANSITION', status: current.status, command },
        })
      }

      if (command === 'complete') {
        await this.assertCompletable(user, caseId, current, tx)
      }
      if (command !== 'complete' && current.assetDisposal) {
        // 放棄前ロック。財産処分に相当する手続きは着手も止める。
        await this.assertInheritanceDecided(user, caseId)
      }

      const patch: Partial<TaskEntity> = { status: targetStatus(command) }
      if (command === 'complete') {
        // 本人が報告した完了。外部機関による確認ではない。
        patch.completionReportedBy = user.userId
        patch.completionReportedAt = SERVER_TIME
      }
      if (command === 'reopen') {
        patch.completionReportedBy = null
        patch.completionReportedAt = null
      }

      tx.update<TaskEntity>(taskLocation(caseId, taskId), expectedVersion, patch)
      tx.audit({
        caseId,
        type: `task.${command}`,
        target: { collection: collections.tasks.name, id: taskId, version: expectedVersion + 1 },
        detail: { from: current.status, to: patch.status, note: options.note ?? null },
      })

      if (command === 'complete') {
        tx.outbox({
          type: 'task.completed',
          caseId,
          payload: { caseId, taskId },
        })
      }
    })

    return this.view(user, access, caseId, taskId)
  }

  /**
   * 完了条件の検証。
   *
   * 根拠が必要な Task には根拠を求め、一般的な手動 ToDo は本人の報告で
   * 完了できる。全 Task に一律の書類添付を強制しない。
   */
  private async assertCompletable(
    user: AuthenticatedUser,
    caseId: string,
    task: TaskEntity,
    tx: Tx,
  ): Promise<void> {
    if (task.assetDisposal) await this.assertInheritanceDecided(user, caseId)
    if (!task.evidenceRequired) return

    const evidences = await this.evidencesOf(user, caseId, task.id)
    for (const evidence of evidences) {
      const current = await tx.get<EvidenceEntity>(evidenceLocation(caseId, evidence.id))
      if (!current || current.taskId !== task.id) continue
      if (!current.documentId) return
      const document = await tx.get<DocumentEntity>({ collection: collections.documents, caseId, id: current.documentId })
      if (document && !document.archived && document.storageState === 'STORED') return
    }
    throw errors.preconditionFailed({
      message: 'この手続きの完了には利用可能な根拠の登録が必要です。',
      details: { reason: 'EVIDENCE_REQUIRED', taskId: task.id },
    })
  }

  private async assertInheritanceDecided(user: AuthenticatedUser, caseId: string): Promise<void> {
    if (await this.decisions.isConfirmed(user.tenantId, caseId)) return
    throw errors.preconditionFailed({
      message: '相続方法が確定するまで、この手続きは実行できません。',
      details: { reason: 'INHERITANCE_DECISION_REQUIRED' },
    })
  }

  async addEvidence(
    user: AuthenticatedUser,
    caseId: string,
    taskId: string,
    input: { label: string; kind: EvidenceKind; note?: string | null; documentId?: string | null },
    meta: CommandMeta,
  ): Promise<TaskView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const evidenceId = randomUUID()

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      // 対象 Task が同じ Case にあることを確認する。
      await tx.require<TaskEntity>(taskLocation(caseId, taskId))
      if (input.documentId) await this.assertDocument(tx, caseId, input.documentId)
      tx.create<EvidenceEntity>(evidenceLocation(caseId, evidenceId), {
        id: evidenceId,
        taskId,
        label: input.label,
        kind: input.kind,
        note: input.note ?? null,
        documentId: input.documentId ?? null,
        recordedBy: user.userId,
      })
      tx.audit({
        caseId,
        type: 'evidence.recorded',
        target: { collection: collections.evidence.name, id: evidenceId, version: 1 },
        detail: { taskId, kind: input.kind },
      })
    })

    return this.view(user, access, caseId, taskId)
  }

  async listDeadlines(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<DeadlineView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<DeadlineEntity>(user.tenantId, collections.deadlines, caseId, {
      limit: options.limit,
      cursor: options.cursor,
    })
    const today = todayInRuleTimezone()
    const items = page.items.map((entity) => toDeadlineView(entity, today))
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  private async evidencesOf(
    user: AuthenticatedUser,
    caseId: string,
    taskId: string,
  ): Promise<EvidenceEntity[]> {
    const page = await this.read.list<EvidenceEntity>(user.tenantId, collections.evidence, caseId, {
      limit: 50,
      where: [{ field: 'taskId', op: '==', value: taskId }],
      orderBy: { field: 'createdAt', direction: 'desc' },
    })
    return page.items
  }

  private async view(
    user: AuthenticatedUser,
    access: CaseAccess,
    caseId: string,
    taskId: string,
  ): Promise<TaskView> {
    const entity = await this.read.get<TaskEntity>(user.tenantId, taskLocation(caseId, taskId))
    if (!entity) throw errors.notFound()
    return this.viewOf(user, access, caseId, entity)
  }

  private async viewOf(
    user: AuthenticatedUser,
    access: CaseAccess,
    caseId: string,
    entity: TaskEntity,
  ): Promise<TaskView> {
    const today = todayInRuleTimezone()
    const [evidences, deadlines, decided, dependencies] = await Promise.all([
      this.evidencesOf(user, caseId, entity.id),
      this.read.list<DeadlineEntity>(user.tenantId, collections.deadlines, caseId, {
        limit: 10,
        where: [{ field: 'taskId', op: '==', value: entity.id }],
        orderBy: { field: 'createdAt', direction: 'asc' },
      }),
      this.decisions.isConfirmed(user.tenantId, caseId),
      Promise.all((entity.dependencyTaskIds ?? []).map(id => this.read.get<TaskEntity>(user.tenantId, taskLocation(caseId, id)))),
    ])

    const usableEvidence = (await Promise.all(evidences.map(async evidence => {
      if (!evidence.documentId) return true
      const document = await this.read.get<DocumentEntity>(user.tenantId, {
        collection: collections.documents, caseId, id: evidence.documentId,
      })
      return document !== null && !document.archived && document.storageState === 'STORED'
    }))).some(Boolean)
    const allowedActions: TaskCommand[] = []
    const blockedActions: { action: TaskCommand; reason: TaskBlockedReason }[] = []

    for (const command of ALL_TASK_COMMANDS) {
      if (!isAllowedTransition(command, entity.status)) {
        blockedActions.push({ action: command, reason: 'INVALID_TRANSITION' })
        continue
      }
      if (!access.can('case.write')) {
        blockedActions.push({ action: command, reason: 'INSUFFICIENT_ROLE' })
        continue
      }
      if (this.requiresDependencies(command) && dependencies.some(task => task?.status !== 'COMPLETED')) {
        blockedActions.push({ action: command, reason: 'DEPENDENCY_NOT_COMPLETED' })
        continue
      }
      if (entity.assetDisposal && !decided) {
        blockedActions.push({ action: command, reason: 'INHERITANCE_DECISION_REQUIRED' })
        continue
      }
      if (command === 'complete' && entity.evidenceRequired && !usableEvidence) {
        blockedActions.push({ action: command, reason: 'EVIDENCE_REQUIRED' })
        continue
      }
      allowedActions.push(command)
    }

    const deadlineEntity = deadlines.items[0] ?? null

    return {
      id: entity.id,
      caseId: entity.caseId ?? '',
      title: entity.title,
      summary: entity.summary,
      status: entity.status,
      stage: entity.stage,
      category: entity.category,
      submitTo: entity.submitTo,
      assigneeId: entity.assigneeId,
      dependencyTaskIds: entity.dependencyTaskIds ?? [],
      escalation: entity.escalation ?? null,
      source: entity.source,
      evidenceRequired: entity.evidenceRequired,
      assetDisposal: entity.assetDisposal,
      requiredDocuments: entity.requiredDocuments,
      completionReportedBy: entity.completionReportedBy,
      completionReportedAt: entity.completionReportedAt,
      deadline: deadlineEntity ? toDeadlineView(deadlineEntity, today) : null,
      evidences: evidences.map((evidence) => ({
        id: evidence.id,
        label: evidence.label,
        kind: evidence.kind,
        note: evidence.note,
        recordedAt: evidence.createdAt,
      })),
      allowedActions,
      blockedActions,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    }
  }

  private requiresDependencies(command: TaskCommand): boolean {
    return ['start', 'markReady', 'reportSubmission', 'awaitExternal', 'complete'].includes(command)
  }

  private async assertDocument(tx: Tx, caseId: string, id: string): Promise<void> {
    const document = await tx.require<DocumentEntity>({ collection: collections.documents, caseId, id })
    if (document.archived || document.storageState !== 'STORED') {
      throw errors.preconditionFailed({ details: { reason: 'DOCUMENT_UNAVAILABLE' } })
    }
  }

  private async validateReferences(tx: Tx, caseId: string, taskId: string, input: TaskReferencesInput): Promise<void> {
    if (input.assigneeId) {
      const person = await tx.require<Person & EntityBase>({ collection: collections.persons, caseId, id: input.assigneeId })
      if (person.excludedAt) throw errors.preconditionFailed({ details: { reason: 'ASSIGNEE_EXCLUDED' } })
    }
    if (input.requiredDocuments) {
      if (new Set(input.requiredDocuments.map(ref => ref.id)).size !== input.requiredDocuments.length) {
        throw errors.validationFailed({ details: { reason: 'DUPLICATE_DOCUMENT_REQUIREMENT' } })
      }
      for (const ref of input.requiredDocuments) if (ref.documentId) await this.assertDocument(tx, caseId, ref.documentId)
    }
    if (input.dependencyTaskIds) {
      if (new Set(input.dependencyTaskIds).size !== input.dependencyTaskIds.length) throw errors.validationFailed()
      const visited = new Set<string>()
      const pending = [...input.dependencyTaskIds]
      while (pending.length) {
        const id = pending.pop()!
        if (id === taskId) throw errors.preconditionFailed({ details: { reason: 'DEPENDENCY_CYCLE' } })
        if (visited.has(id)) continue
        visited.add(id)
        if (visited.size > 200) throw errors.preconditionFailed({ details: { reason: 'DEPENDENCY_GRAPH_TOO_LARGE' } })
        const dependency = await tx.require<TaskEntity>(taskLocation(caseId, id))
        pending.push(...(dependency.dependencyTaskIds ?? []))
      }
    }
  }
}

/**
 * 期限の表示用データ。
 *
 * 算定できていない期限に残日数や重大度を付けない。0 日を返すと
 * 画面は「今日が期限」と表示する。
 */
export function toDeadlineView(entity: DeadlineEntity, today: string): DeadlineView {
  const remaining = entity.confirmation === 'CONFIRMED' ? daysRemaining(entity.dueDate, today) : null
  return {
    id: entity.id,
    taskId: entity.taskId,
    label: entity.label,
    basisLabel: entity.basisLabel,
    startDate: entity.startDate,
    // 未確認のルールから算定した日付は表示用にも出さない。
    dueDate: entity.confirmation === 'CONFIRMED' ? entity.dueDate : null,
    daysRemaining: remaining,
    severity: severityOf(remaining),
    confirmation: entity.confirmation,
    unresolvedReason: entity.unresolvedReason,
    jurisdiction: entity.jurisdiction,
    timezone: entity.timezone,
    ruleId: entity.ruleId,
    ruleVersion: entity.ruleVersion,
    sourceUrl: entity.sourceUrl,
    sourceCheckedAt: entity.sourceCheckedAt,
    extendable: entity.extendable,
    critical: entity.critical,
  }
}
