import type { ProcedureFacts } from '../../domain/case/case-profile.js'
import { resolveProcedure } from '../../domain/task/procedure-conditions.js'
import {
  canonicalDeadlineId,
  initialTaskId,
  planProcedureSync,
} from '../../domain/task/procedure-sync.js'
import type { SyncSnapshot, ExistingTask } from '../../domain/task/procedure-sync.js'
import type { DeadlineEntity } from '../../domain/task/deadline.js'
import type { EvidenceEntity } from '../../domain/task/evidence.js'
import type { RuleCatalog } from '../../domain/task/rule-engine.js'
import type { TaskEntity } from '../../domain/task/task.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { collections } from '../../domain/shared/collections.js'
import type { DocLocation, ReadRepository, Tx } from '../ports/persistence.js'
import type { CollectionDescriptor } from '../../domain/shared/collections.js'

/** 洗い出しの起点。監査 `task.rule_synced` の detail に残す。 */
export type SyncTrigger = 'CASE_CREATED' | 'CASE_UPDATED' | 'OUTBOX' | 'INITIALIZE' | 'REEVALUATE'

export interface SyncPreparation {
  /** evidence が 1 件でも登録されている Task ID。 */
  taskIdsWithEvidence: Set<string>
  /** 他 Task の dependencyTaskIds に現れる Task ID。 */
  dependedTaskIds: Set<string>
  /** Task ID ごとの Deadline ID（正規 ID 以外の legacy 形式を含む）。 */
  deadlineIdsByTaskId: Map<string, string[]>
}

/** Case 作成時など、既存の Task/Deadline/evidence が無いと確定している場合に使う。 */
export const EMPTY_PREPARATION: SyncPreparation = {
  taskIdsWithEvidence: new Set(),
  dependedTaskIds: new Set(),
  deadlineIdsByTaskId: new Map(),
}

export interface SyncOutcome {
  createdTaskIds: string[]
  removedTaskIds: string[]
  changedDeadlineIds: string[]
}

function taskLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.tasks, caseId, id }
}

function deadlineLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.deadlines, caseId, id }
}

function guidanceLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.guidance, caseId, id }
}

/**
 * 洗い出し（syncRuleTasks 相当）の Application 層。
 *
 * `prepare` は tx の外で Task ID を持たない検索（evidence・依存関係・
 * legacy Deadline ID）を済ませる。`apply` は tx の中で読み書きを行う。
 */
export class ProcedureSyncService {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly read: ReadRepository,
  ) {}

  /** collection 全ページを読み切る（limit 100）。 */
  private async paginateAll<T extends EntityBase>(
    tenantId: string,
    collection: CollectionDescriptor,
    caseId: string,
  ): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.read.list<T>(tenantId, collection, caseId, { limit: 100, cursor })
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return items
  }

  async prepare(tenantId: string, caseId: string): Promise<SyncPreparation> {
    const taskIdsWithEvidence = new Set<string>()
    const dependedTaskIds = new Set<string>()
    const deadlineIdsByTaskId = new Map<string, string[]>()

    const [evidences, tasks, deadlines] = await Promise.all([
      this.paginateAll<EvidenceEntity>(tenantId, collections.evidence, caseId),
      this.paginateAll<TaskEntity>(tenantId, collections.tasks, caseId),
      this.paginateAll<DeadlineEntity>(tenantId, collections.deadlines, caseId),
    ])

    for (const evidence of evidences) taskIdsWithEvidence.add(evidence.taskId)
    for (const task of tasks) {
      for (const dependencyId of task.dependencyTaskIds ?? []) dependedTaskIds.add(dependencyId)
    }
    for (const deadline of deadlines) {
      if (!deadline.taskId) continue
      const ids = deadlineIdsByTaskId.get(deadline.taskId) ?? []
      ids.push(deadline.id)
      deadlineIdsByTaskId.set(deadline.taskId, ids)
    }

    return { taskIdsWithEvidence, dependedTaskIds, deadlineIdsByTaskId }
  }

  async apply(
    tx: Tx,
    input: ProcedureFacts & { caseId: string },
    prep: SyncPreparation,
    trigger: SyncTrigger,
  ): Promise<SyncOutcome> {
    const { caseId, ...facts } = input
    const byProcedureId = new Map<string, ExistingTask>()

    if (trigger !== 'CASE_CREATED') {
      // 新規 Case（caseId は新規 UUID）では既存文書は無いと確定しているため、
      // 28 手続き分の Task 読み取りを丸ごと省略する（Tx.create の ALREADY_EXISTS が二重防止）。
      //
      // 読み取りは意図的に逐次実行する。Firestore Transaction への `Promise.all` による
      // 同時読み取りは、（Emulator 相手には特に）レスポンスが返らず tx 全体が止まることが
      // 実地で確認されたため、安全側の逐次 await に倒す。
      for (const procedure of this.catalog.initialProcedures) {
        const taskId = initialTaskId(caseId, procedure.id)
        const task = await tx.get<TaskEntity>(taskLocation(caseId, taskId))
        if (!task) continue

        const canonicalId = canonicalDeadlineId(caseId, taskId)
        const extraIds = (prep.deadlineIdsByTaskId.get(taskId) ?? []).filter((id) => id !== canonicalId)
        const deadlines: DeadlineEntity[] = []
        const canonical = await tx.get<DeadlineEntity>(deadlineLocation(caseId, canonicalId))
        if (canonical) deadlines.push(canonical)
        for (const id of extraIds) {
          const extra = await tx.get<DeadlineEntity>(deadlineLocation(caseId, id))
          if (extra) deadlines.push(extra)
        }

        let untouched = false
        const resolved = resolveProcedure(procedure, facts)
        if (resolved.include === 'no' && task.status === 'NOT_STARTED') {
          const guidance = await tx.get<EntityBase>(guidanceLocation(caseId, taskId))
          untouched = (task.assigneeId ?? null) === null
            && (task.dependencyTaskIds ?? []).length === 0
            && !prep.dependedTaskIds.has(taskId)
            && (task.escalation ?? null) === null
            && !(task.requiredDocuments ?? []).some((document) => document.documentId)
            && !prep.taskIdsWithEvidence.has(taskId)
            && guidance === null
        }

        byProcedureId.set(procedure.id, { task, deadlines, untouched })
      }
    }

    const snapshot: SyncSnapshot = { caseId, byProcedureId }
    const plan = planProcedureSync(this.catalog, facts, snapshot)

    for (const { task, deadline } of plan.createTasks) {
      tx.create<TaskEntity>(taskLocation(caseId, task.id), task)
      if (deadline) tx.create<DeadlineEntity>(deadlineLocation(caseId, deadline.id), deadline)
    }
    for (const { id, expectedVersion, patch } of plan.updateTasks) {
      tx.update<TaskEntity>(taskLocation(caseId, id), expectedVersion, patch)
    }
    for (const { id, expectedVersion, procedureId } of plan.deleteTasks) {
      tx.delete(taskLocation(caseId, id), expectedVersion)
      tx.audit({
        caseId,
        type: 'task.removed_by_rule',
        target: { collection: collections.tasks.name, id, version: null },
        detail: { procedureId, reason: 'NOT_APPLICABLE' },
      })
    }
    for (const deadline of plan.createDeadlines) {
      tx.create<DeadlineEntity>(deadlineLocation(caseId, deadline.id), deadline)
    }
    for (const { id, expectedVersion, patch } of plan.updateDeadlines) {
      tx.update<DeadlineEntity>(deadlineLocation(caseId, id), expectedVersion, patch)
    }
    for (const { id, expectedVersion } of plan.deleteDeadlines) {
      tx.delete(deadlineLocation(caseId, id), expectedVersion)
    }

    const changedDeadlineIds = [
      ...plan.createTasks.filter((entry) => entry.deadline).map((entry) => entry.deadline!.id),
      ...plan.createDeadlines.map((deadline) => deadline.id),
      ...plan.updateDeadlines.map((entry) => entry.id),
    ]
    const anyChange = plan.createTasks.length > 0 || plan.updateTasks.length > 0 || plan.deleteTasks.length > 0
      || plan.createDeadlines.length > 0 || plan.updateDeadlines.length > 0 || plan.deleteDeadlines.length > 0

    if (anyChange) {
      tx.audit({
        caseId,
        type: 'task.rule_synced',
        target: { collection: collections.tasks.name, id: caseId, version: null },
        detail: {
          trigger,
          created: plan.summary.created,
          updated: plan.summary.updated,
          removed: plan.summary.removed,
          deadlinesChanged: changedDeadlineIds.length + plan.deleteDeadlines.length,
          placeholderRules: this.catalog.placeholder,
        },
      })
    }

    return {
      createdTaskIds: plan.createTasks.map((entry) => entry.task.id),
      removedTaskIds: plan.deleteTasks.map((entry) => entry.id),
      changedDeadlineIds,
    }
  }
}
