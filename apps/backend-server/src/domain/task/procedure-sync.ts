import { createHash } from 'node:crypto'
import { errors } from '../../shared/app-error.js'
import type { ProcedureFacts } from '../case/case-profile.js'
import type { EntityPatch } from '../shared/entity.js'
import { resolveProcedure } from './procedure-conditions.js'
import type { BasisDates, DeadlineRule, RuleCatalog } from './rule-engine.js'
import { buildDeadlineFacts } from './rule-engine.js'
import type { DeadlineEntity, DeadlineFacts } from './deadline.js'
import type { TaskEntity } from './task.js'

/**
 * 初期手続きの Task ID を定義から決める。
 *
 * Case 作成イベントが二重に届いても、同じ ID を指すため重複しない。
 */
export function initialTaskId(caseId: string, procedureId: string): string {
  return createHash('sha256').update(`${caseId.length}:${caseId}/${procedureId}`).digest('hex').slice(0, 32)
}

/** 正規の Deadline ID。ルール ID を含めない（variant で期限ルールが変わっても doc を差し替えずに更新できる）。 */
export function canonicalDeadlineId(caseId: string, taskId: string): string {
  return initialTaskId(caseId, `deadline:${taskId}`)
}

/** submitTo の出所。legacy（submitToSource 欠落）は submitTo が null なら RULE、非 null なら MANUAL。 */
export function effectiveSubmitToSource(task: Pick<TaskEntity, 'submitToSource' | 'submitTo'>): 'RULE' | 'RESEARCH' | 'MANUAL' {
  return task.submitToSource ?? (task.submitTo === null ? 'RULE' : 'MANUAL')
}

export interface ExistingTask {
  task: TaskEntity
  deadlines: DeadlineEntity[]
  /** NOT_STARTED かつ担当者・依存・引継ぎ・案内・書類紐付けが無い（application 側で算出）。 */
  untouched: boolean
}

export interface SyncSnapshot {
  caseId: string
  byProcedureId: Map<string, ExistingTask>
}

export interface SyncPlan {
  createTasks: { task: Omit<TaskEntity, 'tenantId' | 'caseId' | 'version' | 'schemaVersion' | 'createdAt' | 'updatedAt'>; deadline: DeadlineFacts | null }[]
  updateTasks: { id: string; expectedVersion: number; patch: EntityPatch<TaskEntity> }[]
  deleteTasks: { id: string; expectedVersion: number; procedureId: string }[]
  createDeadlines: DeadlineFacts[]
  updateDeadlines: { id: string; expectedVersion: number; patch: EntityPatch<DeadlineEntity> }[]
  deleteDeadlines: { id: string; expectedVersion: number }[]
  summary: { created: string[]; updated: string[]; removed: string[] }
}

function emptyPlan(): SyncPlan {
  return {
    createTasks: [],
    updateTasks: [],
    deleteTasks: [],
    createDeadlines: [],
    updateDeadlines: [],
    deleteDeadlines: [],
    summary: { created: [], updated: [], removed: [] },
  }
}

function ruleOf(catalog: RuleCatalog, ruleId: string): DeadlineRule {
  const rule = catalog.deadlineRules.find((candidate) => candidate.id === ruleId)
  if (!rule) throw errors.internal({ internal: { reason: 'unknown deadline rule referenced by catalog', ruleId } })
  return rule
}

/** 算定結果が永続項目として一致しているか。 */
function deadlineMatches(current: DeadlineEntity, desired: DeadlineFacts): boolean {
  return (
    current.label === desired.label
    && current.basis === desired.basis
    && current.startDate === desired.startDate
    && current.dueDate === desired.dueDate
    && current.basisLabel === desired.basisLabel
    && current.jurisdiction === desired.jurisdiction
    && current.timezone === desired.timezone
    && current.ruleId === desired.ruleId
    && current.ruleVersion === desired.ruleVersion
    && current.confirmation === desired.confirmation
    && current.unresolvedReason === desired.unresolvedReason
    && current.sourceUrl === desired.sourceUrl
    && current.sourceCheckedAt === desired.sourceCheckedAt
    && current.extendable === desired.extendable
    && current.critical === desired.critical
  )
}

function deadlinePatchOf(desired: DeadlineFacts): EntityPatch<DeadlineEntity> {
  return {
    label: desired.label,
    basis: desired.basis,
    startDate: desired.startDate,
    dueDate: desired.dueDate,
    basisLabel: desired.basisLabel,
    jurisdiction: desired.jurisdiction,
    timezone: desired.timezone,
    ruleId: desired.ruleId,
    ruleVersion: desired.ruleVersion,
    confirmation: desired.confirmation,
    unresolvedReason: desired.unresolvedReason,
    sourceUrl: desired.sourceUrl,
    sourceCheckedAt: desired.sourceCheckedAt,
    extendable: desired.extendable,
    critical: desired.critical,
  }
}

/** 望ましい Deadline 状態を既存 Task の Deadline 群へ適用する差分を組み立てる。 */
function syncDeadlinesForIncludedProcedure(
  plan: SyncPlan,
  catalog: RuleCatalog,
  dates: BasisDates,
  caseId: string,
  taskId: string,
  deadlineRuleId: string | null,
  existingDeadlines: DeadlineEntity[],
): boolean {
  let changed = false
  if (deadlineRuleId === null) {
    for (const deadline of existingDeadlines) {
      plan.deleteDeadlines.push({ id: deadline.id, expectedVersion: deadline.version })
      changed = true
    }
    return changed
  }
  const rule = ruleOf(catalog, deadlineRuleId)
  const canonicalId = canonicalDeadlineId(caseId, taskId)
  const desired = buildDeadlineFacts(rule, dates, { id: canonicalId, taskId })
  const canonical = existingDeadlines.find((deadline) => deadline.id === canonicalId)

  if (!canonical) {
    plan.createDeadlines.push(desired)
    changed = true
  } else if (!deadlineMatches(canonical, desired)) {
    plan.updateDeadlines.push({ id: canonical.id, expectedVersion: canonical.version, patch: deadlinePatchOf(desired) })
    changed = true
  }
  for (const deadline of existingDeadlines) {
    if (deadline.id !== canonicalId) {
      plan.deleteDeadlines.push({ id: deadline.id, expectedVersion: deadline.version })
      changed = true
    }
  }
  return changed
}

/** include==='no' で touched な Task の既存 Deadline を、日付だけ再計算する（ルールがカタログに無ければ放置）。 */
function recomputeUntrackedDeadlines(
  plan: SyncPlan,
  catalog: RuleCatalog,
  dates: BasisDates,
  existingDeadlines: DeadlineEntity[],
): boolean {
  let changed = false
  for (const deadline of existingDeadlines) {
    const rule = catalog.deadlineRules.find((candidate) => candidate.id === deadline.ruleId)
    if (!rule) continue
    const desired = buildDeadlineFacts(rule, dates, { id: deadline.id, taskId: deadline.taskId })
    if (!deadlineMatches(deadline, desired)) {
      plan.updateDeadlines.push({ id: deadline.id, expectedVersion: deadline.version, patch: deadlinePatchOf(desired) })
      changed = true
    }
  }
  return changed
}

/**
 * 洗い出し（syncRuleTasks 相当）の純粋関数版。
 *
 * I/O を持たず、既存の Task/Deadline のスナップショットとカタログ・Case の事実から
 * 適用すべき差分だけを組み立てる。tx への適用は `application/task/procedure-sync-service.ts`。
 */
export function planProcedureSync(catalog: RuleCatalog, facts: ProcedureFacts, snapshot: SyncSnapshot): SyncPlan {
  const plan = emptyPlan()
  const dates: BasisDates = { dateOfDeath: facts.dateOfDeath, knownAt: facts.knownAt }

  for (const procedure of catalog.initialProcedures) {
    const resolved = resolveProcedure(procedure, facts)
    const existing = snapshot.byProcedureId.get(procedure.id)
    const taskId = initialTaskId(snapshot.caseId, procedure.id)

    if (resolved.include === 'no') {
      if (!existing) continue
      if (existing.untouched) {
        plan.deleteTasks.push({ id: existing.task.id, expectedVersion: existing.task.version, procedureId: procedure.id })
        for (const deadline of existing.deadlines) {
          plan.deleteDeadlines.push({ id: deadline.id, expectedVersion: deadline.version })
        }
        plan.summary.removed.push(procedure.id)
      } else if (recomputeUntrackedDeadlines(plan, catalog, dates, existing.deadlines)) {
        plan.summary.updated.push(procedure.id)
      }
      continue
    }

    // include === 'yes' | 'maybe'
    if (!existing) {
      const task: SyncPlan['createTasks'][number]['task'] = {
        id: taskId,
        title: resolved.title,
        summary: resolved.summary,
        status: 'NOT_STARTED',
        stage: procedure.stage,
        category: procedure.category,
        submitTo: resolved.submitTo,
        assigneeId: null,
        dependencyTaskIds: [],
        escalation: null,
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
        conditional: resolved.include === 'maybe',
        submitToSource: 'RULE',
      }
      const deadline = resolved.deadlineRuleId
        ? buildDeadlineFacts(ruleOf(catalog, resolved.deadlineRuleId), dates, {
            id: canonicalDeadlineId(snapshot.caseId, taskId),
            taskId,
          })
        : null
      plan.createTasks.push({ task, deadline })
      plan.summary.created.push(procedure.id)
    } else {
      const patch: EntityPatch<TaskEntity> = {}
      if (resolved.title !== existing.task.title) patch.title = resolved.title
      if (resolved.summary !== existing.task.summary) patch.summary = resolved.summary
      const conditionalDesired = resolved.include === 'maybe'
      if ((existing.task.conditional ?? false) !== conditionalDesired) patch.conditional = conditionalDesired
      if (effectiveSubmitToSource(existing.task) === 'RULE' && existing.task.submitTo !== resolved.submitTo) {
        patch.submitTo = resolved.submitTo
      }
      if (Object.keys(patch).length > 0) {
        plan.updateTasks.push({ id: existing.task.id, expectedVersion: existing.task.version, patch })
      }
      const deadlinesChanged = syncDeadlinesForIncludedProcedure(
        plan, catalog, dates, snapshot.caseId, existing.task.id, resolved.deadlineRuleId, existing.deadlines,
      )
      if (Object.keys(patch).length > 0 || deadlinesChanged) plan.summary.updated.push(procedure.id)
    }
  }

  return plan
}
