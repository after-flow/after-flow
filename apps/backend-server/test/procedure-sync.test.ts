import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalDeadlineId, initialTaskId, planProcedureSync } from '../src/domain/task/procedure-sync.js'
import type { ExistingTask, SyncSnapshot } from '../src/domain/task/procedure-sync.js'
import { PLACEHOLDER_RULE_CATALOG } from '../src/domain/task/rule-catalog.js'
import type { DeadlineEntity } from '../src/domain/task/deadline.js'
import type { DeadlineRule, InitialProcedure, RuleCatalog } from '../src/domain/task/rule-engine.js'
import type { TaskEntity } from '../src/domain/task/task.js'
import type { ProcedureFacts } from '../src/domain/case/case-profile.js'

const CASE_ID = 'case-fixture'

function factsOf(overrides: Partial<ProcedureFacts> = {}): ProcedureFacts {
  return { dateOfDeath: '2026-04-01', knownAt: '2026-04-03', dateOfBirth: null, profile: null, ...overrides }
}

function emptySnapshot(): SyncSnapshot {
  return { caseId: CASE_ID, byProcedureId: new Map() }
}

describe('planProcedureSync: 空スナップショットからの作成', () => {
  it('profile未回答の新規Caseでは22件のTaskを作る（default no の5件は出ない）', () => {
    const plan = planProcedureSync(PLACEHOLDER_RULE_CATALOG, factsOf(), emptySnapshot())
    assert.equal(plan.createTasks.length, 22)
    assert.equal(plan.updateTasks.length, 0)
    assert.equal(plan.deleteTasks.length, 0)
  })

  it('全項目 YES・EMPLOYEE でも MAX_INITIAL_PROCEDURES 以下で、employer/self-employed は排他', () => {
    const profile = {
      healthInsurance: 'EMPLOYEE' as const, pension: 'EMPLOYEES' as const, occupation: 'EMPLOYEE' as const,
      realEstate: 'YES' as const, car: 'YES' as const, mortgage: 'YES' as const, answeredAt: '2026-09-20T00:00:00+09:00',
    }
    const plan = planProcedureSync(PLACEHOLDER_RULE_CATALOG, factsOf({ profile }), emptySnapshot())
    assert.ok(plan.createTasks.length <= 28)
    const ids = plan.createTasks.map((entry) => entry.task.procedureId)
    assert.ok(!ids.includes('self-employed-notification'))
    assert.ok(ids.includes('employer-procedures'))
  })

  it('maybe な手続きは conditional:true で作られる', () => {
    const plan = planProcedureSync(PLACEHOLDER_RULE_CATALOG, factsOf(), emptySnapshot())
    const householdChange = plan.createTasks.find((entry) => entry.task.procedureId === 'household-change')
    assert.ok(householdChange)
    assert.equal(householdChange!.task.conditional, true)
    const deathNotification = plan.createTasks.find((entry) => entry.task.procedureId === 'death-notification')
    assert.equal(deathNotification!.task.conditional, false)
  })
})

/* ---------- 小さな架空カタログで既存Taskとの差分を確認する ---------- */

const fixtureRule: DeadlineRule = {
  id: 'fixture-rule',
  version: '1.0.0',
  label: '架空の期限',
  basis: 'DATE_OF_DEATH',
  period: { unit: 'DAY', count: 14, includeFirstDay: false },
  basisLabel: '亡くなった日の翌日から数えて14日以内',
  knownAtLabel: null,
  legalNature: 'STATUTORY',
  jurisdiction: '全国',
  reviewed: true,
  sourceUrl: 'https://example.test/fixture',
  sourceCheckedAt: '2026-09-20T00:00:00+09:00',
  extendable: null,
  critical: true,
  reviewedBy: { name: 'テスト 実装者', qualification: 'ENGINEER' },
}

const fixtureRuleAlt: DeadlineRule = { ...fixtureRule, id: 'fixture-rule-alt', basisLabel: '別ルート' }

function fixtureProcedure(overrides: Partial<InitialProcedure> = {}): InitialProcedure {
  return {
    id: 'fixture-procedure',
    title: '基本タイトル',
    summary: '基本サマリー',
    stage: 'government',
    category: 'カテゴリ',
    submitTo: '基本窓口',
    evidenceRequired: false,
    assetDisposal: false,
    requiredDocuments: [],
    deadlineRuleId: 'fixture-rule',
    applicability: { default: 'yes', rules: [] },
    variants: [],
    targetDate: null,
    ...overrides,
  }
}

function fixtureCatalog(procedure: InitialProcedure, rules: DeadlineRule[] = [fixtureRule, fixtureRuleAlt]): RuleCatalog {
  return {
    placeholder: true,
    deadlineRules: rules,
    initialProcedures: [procedure],
    deliberationDeadlineRuleId: null,
    reviewedBy: null,
    reviewedAt: null,
  }
}

function taskEntity(overrides: Partial<TaskEntity> = {}): TaskEntity {
  return {
    id: initialTaskId(CASE_ID, 'fixture-procedure'),
    tenantId: 'tenant', caseId: CASE_ID, version: 1, schemaVersion: 1,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    title: '基本タイトル', summary: '基本サマリー', status: 'NOT_STARTED', stage: 'government', category: 'カテゴリ',
    submitTo: '基本窓口', assigneeId: null, dependencyTaskIds: [], escalation: null,
    source: 'RULE_ENGINE', procedureId: 'fixture-procedure', requiredDocuments: [],
    evidenceRequired: false, assetDisposal: false, completionReportedBy: null, completionReportedAt: null,
    conditional: false, submitToSource: 'RULE',
    ...overrides,
  }
}

function deadlineEntity(overrides: Partial<DeadlineEntity> = {}): DeadlineEntity {
  return {
    id: canonicalDeadlineId(CASE_ID, initialTaskId(CASE_ID, 'fixture-procedure')),
    tenantId: 'tenant', caseId: CASE_ID, version: 1, schemaVersion: 1,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    taskId: initialTaskId(CASE_ID, 'fixture-procedure'), label: '架空の期限', basis: 'DATE_OF_DEATH',
    startDate: '2026-04-01', dueDate: '2026-04-15', basisLabel: '亡くなった日の翌日から数えて14日以内',
    jurisdiction: '全国', timezone: 'Asia/Tokyo', ruleId: 'fixture-rule', ruleVersion: '1.0.0',
    confirmation: 'CONFIRMED', unresolvedReason: null, sourceUrl: 'https://example.test/fixture',
    sourceCheckedAt: '2026-09-20T00:00:00+09:00', extendable: null, critical: true,
    ...overrides,
  }
}

function snapshotOf(existing: ExistingTask | undefined): SyncSnapshot {
  const byProcedureId = new Map<string, ExistingTask>()
  if (existing) byProcedureId.set('fixture-procedure', existing)
  return { caseId: CASE_ID, byProcedureId }
}

describe('planProcedureSync: no で untouched → 削除', () => {
  it('NOT_STARTED・記録なしの手続きは削除し、Deadlineも削除する', () => {
    const procedure = fixtureProcedure({ applicability: { default: 'no', rules: [] } })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const deadline = deadlineEntity()
    const plan = planProcedureSync(catalog, factsOf(), snapshotOf({ task, deadlines: [deadline], untouched: true }))
    assert.equal(plan.deleteTasks.length, 1)
    assert.equal(plan.deleteTasks[0]!.procedureId, 'fixture-procedure')
    assert.equal(plan.deleteDeadlines.length, 1)
    assert.deepEqual(plan.summary.removed, ['fixture-procedure'])
  })
})

describe('planProcedureSync: no で touched → 手を付けない', () => {
  it('Task は変更せず、Deadline だけ日付を再計算する', () => {
    const procedure = fixtureProcedure({ applicability: { default: 'no', rules: [] } })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity({ status: 'COLLECTING_INFORMATION' })
    // ruleId は fixture-rule のまま。knownAt/dateOfDeath を変えて起算日訂正を再現。
    const deadline = deadlineEntity({ startDate: '2026-05-01', dueDate: '2026-05-15' })
    const plan = planProcedureSync(catalog, factsOf({ dateOfDeath: '2026-04-01' }),
      snapshotOf({ task, deadlines: [deadline], untouched: false }))
    assert.equal(plan.deleteTasks.length, 0)
    assert.equal(plan.updateTasks.length, 0)
    assert.equal(plan.updateDeadlines.length, 1)
    assert.equal(plan.updateDeadlines[0]!.patch.dueDate, '2026-04-15')
  })

  it('カタログに無いルールは放置する', () => {
    const procedure = fixtureProcedure({ applicability: { default: 'no', rules: [] } })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity({ status: 'COLLECTING_INFORMATION' })
    const deadline = deadlineEntity({ ruleId: 'removed-rule' })
    const plan = planProcedureSync(catalog, factsOf(), snapshotOf({ task, deadlines: [deadline], untouched: false }))
    assert.equal(plan.updateDeadlines.length, 0)
  })
})

describe('planProcedureSync: yes の既存 Task', () => {
  it('title/summary/conditional の差分だけpatchする', () => {
    const procedure = fixtureProcedure({ title: '新タイトル', summary: '新サマリー' })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const deadline = deadlineEntity()
    const plan = planProcedureSync(catalog, factsOf(), snapshotOf({ task, deadlines: [deadline], untouched: true }))
    assert.equal(plan.updateTasks.length, 1)
    assert.deepEqual(plan.updateTasks[0]!.patch, { title: '新タイトル', summary: '新サマリー' })
  })

  it('submitToSource が RULE のときだけ submitTo を規則で上書きする', () => {
    const procedure = fixtureProcedure({ submitTo: '規則の窓口' })
    const catalog = fixtureCatalog(procedure)
    const ruleTask = taskEntity({ submitTo: '古い窓口', submitToSource: 'RULE' })
    const planForRule = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: ruleTask, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(planForRule.updateTasks[0]!.patch.submitTo, '規則の窓口')

    const manualTask = taskEntity({ submitTo: '手動で調べた窓口', submitToSource: 'MANUAL' })
    const planForManual = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: manualTask, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(planForManual.updateTasks.length, 0)
  })

  it('legacy（submitToSource欠落）は規則由来の Task なら RULE 扱いで、規則の窓口（variant を含む）に追随する', () => {
    const procedure = fixtureProcedure({ submitTo: '規則の窓口' })
    const catalog = fixtureCatalog(procedure)
    const legacyNull = taskEntity({ submitTo: null, submitToSource: undefined })
    const planA = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: legacyNull, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(planA.updateTasks[0]!.patch.submitTo, '規則の窓口')

    const legacyFilled = taskEntity({ submitTo: '以前の規則の窓口', submitToSource: undefined })
    const planB = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: legacyFilled, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(planB.updateTasks[0]!.patch.submitTo, '規則の窓口')
  })

  it('利用者が直した title/summary（textSource MANUAL）は規則の文言に戻さない', () => {
    const procedure = fixtureProcedure({ title: '規則のタイトル', summary: '規則のサマリー' })
    const catalog = fixtureCatalog(procedure)
    const edited = taskEntity({ title: '自分で直したタイトル', summary: '自分で直したサマリー', textSource: 'MANUAL' })
    const plan = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: edited, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(plan.updateTasks.length, 0)

    const untouched = taskEntity({ title: '古い規則のタイトル', textSource: undefined })
    const planRule = planProcedureSync(catalog, factsOf(),
      snapshotOf({ task: untouched, deadlines: [deadlineEntity()], untouched: true }))
    assert.equal(planRule.updateTasks[0]!.patch.title, '規則のタイトル')
  })

  it('variant で期限ルールが切り替わると、同じ正規Deadline docのruleIdが更新される', () => {
    const procedure = fixtureProcedure({
      deadlineRuleId: 'fixture-rule',
      variants: [{ when: { field: 'pension', in: ['NATIONAL_ONLY'] }, deadlineRuleId: 'fixture-rule-alt' }],
    })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const deadline = deadlineEntity()
    const facts = factsOf({
      profile: {
        healthInsurance: 'UNKNOWN', pension: 'NATIONAL_ONLY', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    const plan = planProcedureSync(catalog, facts, snapshotOf({ task, deadlines: [deadline], untouched: true }))
    assert.equal(plan.updateDeadlines.length, 1)
    assert.equal(plan.updateDeadlines[0]!.id, deadline.id)
    assert.equal(plan.updateDeadlines[0]!.patch.ruleId, 'fixture-rule-alt')
    assert.equal(plan.createDeadlines.length, 0)
    assert.equal(plan.deleteDeadlines.length, 0)
  })

  it('期限なしvariant（deadlineRuleId:null）でDeadlineを削除する', () => {
    const procedure = fixtureProcedure({
      deadlineRuleId: 'fixture-rule',
      variants: [{ when: { field: 'pension', in: ['NONE'] }, deadlineRuleId: null }],
    })
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const deadline = deadlineEntity()
    const facts = factsOf({
      profile: {
        healthInsurance: 'UNKNOWN', pension: 'NONE', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    const plan = planProcedureSync(catalog, facts, snapshotOf({ task, deadlines: [deadline], untouched: true }))
    assert.equal(plan.deleteDeadlines.length, 1)
    assert.equal(plan.createDeadlines.length, 0)
    assert.equal(plan.updateDeadlines.length, 0)
  })

  it('legacy Deadline ID（正規IDでない）は正規IDへ差し替える', () => {
    const procedure = fixtureProcedure()
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const legacyDeadline = deadlineEntity({ id: 'deadline:fixture-rule:legacy-task-id' })
    const plan = planProcedureSync(catalog, factsOf(), snapshotOf({ task, deadlines: [legacyDeadline], untouched: true }))
    assert.equal(plan.deleteDeadlines.length, 1)
    assert.equal(plan.deleteDeadlines[0]!.id, 'deadline:fixture-rule:legacy-task-id')
    assert.equal(plan.createDeadlines.length, 1)
    assert.equal(plan.createDeadlines[0]!.id, canonicalDeadlineId(CASE_ID, task.id))
  })

  it('無変更なら plan が空になる', () => {
    const procedure = fixtureProcedure()
    const catalog = fixtureCatalog(procedure)
    const task = taskEntity()
    const deadline = deadlineEntity()
    const plan = planProcedureSync(catalog, factsOf(), snapshotOf({ task, deadlines: [deadline], untouched: true }))
    assert.equal(plan.createTasks.length, 0)
    assert.equal(plan.updateTasks.length, 0)
    assert.equal(plan.deleteTasks.length, 0)
    assert.equal(plan.createDeadlines.length, 0)
    assert.equal(plan.updateDeadlines.length, 0)
    assert.equal(plan.deleteDeadlines.length, 0)
    assert.deepEqual(plan.summary, { created: [], updated: [], removed: [] })
  })
})
