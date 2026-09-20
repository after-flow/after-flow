import { seedHeir } from './helpers/app.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { AgentRunEntity, AgentRunStatus } from '../../src/domain/agent/agent-run.js'
import { collections } from '../../src/domain/shared/collections.js'
import { CaseOverviewService } from '../../src/application/overview/overview-service.js'
import { AccessService } from '../../src/application/authorization/case-access.js'
import type { DocLocation, ReadRepository } from '../../src/application/ports/persistence.js'
import { FirestoreReadRepository } from '../../src/infrastructure/firestore/read-repository.js'
import type { CaseMember } from '../../src/domain/authorization/case-role.js'
import type { RuleCatalog } from '../../src/domain/task/rule-engine.js'
import { agreeRequiredConsents, buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import type { Json, TestAppOptions } from './helpers/app.js'
import { describeFirestore, firestore, newTenantId, unitOfWork, workContext } from './helpers/emulator.js'

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  knownAt: '2026-04-03',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

describeFirestore('集約のスナップショット整合性', () => {
  it('読取時点の決定後に更新が確定しても全クエリは同じ時点を返す', async () => {
    const { tenantId, userId, app, caseId } = await setup()
    const task = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', {
      title: '集計中に更新する架空Task', stage: 'immediate', category: '手動',
    }))
    const taskId = task.body.data.id as string
    const before = await call(app, `/cases/${caseId}/overview`)
    assert.equal(before.status, 200)
    class InterleavedRead extends FirestoreReadRepository {
      override snapshot<T>(tenant: string, anchor: DocLocation,
        fn: (read: ReadRepository, readAt: string) => Promise<T>): Promise<T> {
        return super.snapshot(tenant, anchor, async (read, readAt) => {
          await firestore().doc(`tenants/${tenantId}/cases/${caseId}/tasks/${taskId}`)
            .update({ status: 'COMPLETED', stage: 'closing', version: 2 })
          return fn(read, readAt)
        })
      }
    }
    const read = new InterleavedRead(firestore())
    const snapshot = await new CaseOverviewService(new AccessService(read), read)
      .get({ tenantId, userId }, caseId)
    assert.equal(snapshot.consistency, 'SNAPSHOT')
    assert.deepEqual(snapshot.taskCounts, before.body.data.taskCounts)
    assert.deepEqual(snapshot.flowStages, before.body.data.flowStages)
    const after = await call(app, `/cases/${caseId}/overview`)
    assert.equal(after.body.data.taskCounts.COMPLETED, 1)
    assert.equal(after.body.data.flowStages.find((s: Json) => s.id === 'closing').completedTasks, 1)
    assert.equal(after.body.data.caseVersion, snapshot.caseVersion, 'Task更新をCase版と混同しない')
  })
})

/** 業務レビュー済みという前提の架空ルール。実際の法定期限ではない。 */
const REVIEWED_CATALOG: RuleCatalog = {
  placeholder: false,
  deadlineRules: [
    {
      id: 'fixture-confirmed',
      version: '1.0.0',
      label: '架空の確定した期限',
      basis: 'KNOWN_AT',
      offsetDays: 7,
      jurisdiction: '架空市',
      reviewed: true,
      sourceUrl: 'https://example.test/fixture',
      sourceCheckedAt: '2026-09-20T00:00:00+09:00',
      extendable: false,
      critical: true,
    },
    {
      id: 'fixture-unreviewed',
      version: '0.0.0-draft',
      label: '架空の未レビュー期限',
      basis: 'KNOWN_AT',
      offsetDays: 14,
      jurisdiction: '架空市',
      reviewed: false,
      sourceUrl: null,
      sourceCheckedAt: null,
      extendable: null,
      critical: false,
    },
  ],
  initialProcedures: [
    {
      id: 'fixture-a',
      title: '架空の手続きA',
      summary: '',
      stage: 'immediate',
      category: '行政手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: 'fixture-confirmed',
    },
    {
      id: 'fixture-b',
      title: '架空の手続きB',
      summary: '',
      stage: 'immediate',
      category: '行政手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: 'fixture-unreviewed',
    },
    {
      id: 'fixture-c',
      title: '架空の手続きC',
      summary: '',
      stage: 'government',
      category: '書類収集',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: null,
    },
  ],
}

let keyCounter = 0
function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${String(keyCounter).padStart(8, '0')}`
}

async function setup(options: TestAppOptions = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, { ruleCatalog: REVIEWED_CATALOG, ...options })
  await agreeRequiredConsents(app)
  const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
  const caseId = created.body.data.id as string
  return { tenantId, userId, app, caseId }
}

async function linkPerson(tenantId: string, caseId: string, userId: string, personId: string) {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    const member = await tx.require<CaseMember>({
      collection: collections.caseMembers,
      caseId,
      id: userId,
    })
    tx.update<CaseMember>({ collection: collections.caseMembers, caseId, id: userId }, member.version, {
      personId,
    })
  })
}

async function setRunStatus(
  tenantId: string,
  caseId: string,
  runId: string,
  status: AgentRunStatus,
  detail: { waitingFor?: string | null; failureReason?: string | null } = {},
) {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    const run = await tx.require<AgentRunEntity>({
      collection: collections.agentRuns,
      caseId,
      id: runId,
    })
    tx.update<AgentRunEntity>(
      { collection: collections.agentRuns, caseId, id: runId },
      run.version,
      {
        status,
        waitingFor: detail.waitingFor ?? null,
        failureReason: detail.failureReason ?? null,
      },
    )
  })
}

describeFirestore('案件の概要', () => {
  it('作成直後は手続きが無く、段階を完了にしない', async () => {
    const { app, caseId } = await setup()
    const response = await call(app, `/cases/${caseId}/overview`)

    assert.equal(response.status, 200)
    assert.equal(response.body.data.totalTasks, 0)
    assert.equal(response.body.data.flowStages.length, 10)
    // 手続きが 0 件の段階を完了にしない。
    for (const stage of response.body.data.flowStages) {
      assert.equal(stage.state, 'NO_TASKS', `${stage.id} が完了扱いになっている`)
    }
    assert.ok(response.body.data.aggregatedAt)
    assert.equal(response.body.data.caseVersion, 1)
  })

  it('手続きの進行を状態別と段階別に集計する', async () => {
    const { app, caseId } = await setup()
    await call(app, `/cases/${caseId}/tasks/initialize`, jsonRequest('POST', {}, nextKey('idem-init')))

    const list = await call(app, `/cases/${caseId}/tasks?limit=50`)
    const taskA = list.body.data.find((task: Json) => task.title === '架空の手続きA')
    await call(
      app,
      `/cases/${caseId}/tasks/${taskA.id}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: taskA.version }),
    )

    const response = await call(app, `/cases/${caseId}/overview`)
    assert.equal(response.body.data.totalTasks, 3)
    assert.equal(response.body.data.taskCounts.COMPLETED, 1)
    assert.equal(response.body.data.taskCounts.NOT_STARTED, 2)

    const immediate = response.body.data.flowStages.find((stage: Json) => stage.id === 'immediate')
    assert.equal(immediate.totalTasks, 2)
    assert.equal(immediate.completedTasks, 1)
    assert.equal(immediate.state, 'IN_PROGRESS')

    const government = response.body.data.flowStages.find((stage: Json) => stage.id === 'government')
    assert.equal(government.state, 'NOT_STARTED')

    const funeral = response.body.data.flowStages.find((stage: Json) => stage.id === 'funeral')
    assert.equal(funeral.state, 'NO_TASKS')
  })

  it('1ページ目だけを数えない', async () => {
    const { app, caseId } = await setup()
    // 一覧の既定ページサイズを超える件数を作る。
    for (let index = 0; index < 12; index += 1) {
      await call(
        app,
        `/cases/${caseId}/tasks`,
        jsonRequest(
          'POST',
          { title: `手続き ${index}`, stage: 'contracts', category: 'その他' },
          nextKey('idem-task'),
        ),
      )
    }

    const response = await call(app, `/cases/${caseId}/overview`)
    assert.equal(response.body.data.totalTasks, 12)
    assert.equal(response.body.data.taskCounts.NOT_STARTED, 12)

    const contracts = response.body.data.flowStages.find((stage: Json) => stage.id === 'contracts')
    assert.equal(contracts.totalTasks, 12)
  })

  it('確定した期限と未確定の期限を区別する', async () => {
    const { app, caseId } = await setup()
    await call(app, `/cases/${caseId}/tasks/initialize`, jsonRequest('POST', {}, nextKey('idem-init')))

    const response = await call(app, `/cases/${caseId}/overview`)
    // 未レビューのルールから算定した期限は日付を持たない。
    assert.equal(response.body.data.upcomingDeadlines.length, 1)
    assert.equal(response.body.data.upcomingDeadlines[0].dueDate, '2026-04-10')
    assert.equal(response.body.data.upcomingDeadlines[0].confirmation, 'CONFIRMED')
    // 算定できていない期限の存在を隠さない。
    assert.equal(response.body.data.unresolvedDeadlineCount, 1)
  })

  it('承認の受付と反映を別に数える', async () => {
    const { app, caseId } = await setup()
    const proposal = await call(
      app,
      `/cases/${caseId}/proposals`,
      jsonRequest(
        'POST',
        {
          kind: 'TASK_PROPOSAL',
          title: '提案',
          payload: { title: '提案からの手続き', stage: 'immediate', category: 'その他' },
        },
        nextKey('idem-proposal'),
      ),
    )
    const approval = await call(
      app,
      `/cases/${caseId}/proposals/${proposal.body.data.id}/approval-requests`,
      jsonRequest('POST', { expectedVersion: proposal.body.data.version }, nextKey('idem-approval')),
    )

    const pending = await call(app, `/cases/${caseId}/overview`)
    assert.equal(pending.body.data.pendingApprovalCount, 1)
    assert.equal(pending.body.data.appliedApprovalCount, 0)

    await call(
      app,
      `/cases/${caseId}/approvals/${approval.body.data.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.body.data.version,
        proposalVersion: approval.body.data.proposalVersion,
        payloadHash: approval.body.data.payloadHash,
      }),
    )

    const applied = await call(app, `/cases/${caseId}/overview`)
    assert.equal(applied.body.data.pendingApprovalCount, 0)
    assert.equal(applied.body.data.appliedApprovalCount, 1)
  })

  it('相続人が未登録なら確定を判定できないことを示す', async () => {
    const { app, caseId } = await setup()
    const response = await call(app, `/cases/${caseId}/overview`)

    assert.equal(response.body.data.inheritanceDecision.decided, false)
    // 記録が無い状態を確定済みにしない。判定できないことを示す。
    assert.equal(response.body.data.inheritanceDecision.unknown, true)
    assert.deepEqual(response.body.data.inheritanceDecision.perHeir, [])
  })

  it('本人の確定と他人の報告を区別して返す', async () => {
    const { tenantId, userId, app, caseId } = await setup()
    await seedHeir(tenantId, caseId, 'person-self')
    await seedHeir(tenantId, caseId, 'person-spouse')
    await linkPerson(tenantId, caseId, userId, 'person-self')

    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-spouse`,
      jsonRequest('POST', { method: 'RENUNCIATION', state: 'REPORTED' }, nextKey('idem-decision')),
    )
    const own = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }, nextKey('idem-decision')),
    )
    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self/confirm`,
      jsonRequest('POST', { expectedVersion: own.body.data.version, method: 'SIMPLE_ACCEPTANCE' }),
    )

    const response = await call(app, `/cases/${caseId}/overview`)
    const perHeir = response.body.data.inheritanceDecision.perHeir as Json[]
    const spouse = perHeir.find((entry) => entry.personId === 'person-spouse')
    const self = perHeir.find((entry) => entry.personId === 'person-self')

    assert.ok(spouse)
    assert.ok(self)
    assert.equal(spouse.state, 'REPORTED')
    // method が入っているだけでは確定にしない。
    assert.equal(spouse.confirmed, false)
    assert.equal(self.confirmed, true)
    // 全員が確定していなければ解除しない。
    assert.equal(response.body.data.inheritanceDecision.decided, false)
    assert.equal(response.body.data.inheritanceDecision.unknown, false)
    assert.equal(self.personName, 'person-self')
  })

  it('AIが未接続であることを活動が無い理由として返す', async () => {
    const { app, caseId } = await setup()
    const response = await call(app, `/cases/${caseId}/overview`)

    assert.equal(response.body.data.aiConnected, false)
    // 架空の活動履歴を返さない。
    assert.deepEqual(response.body.data.recentAgentRuns, [])
  })

  it('AIの受付・待機・失敗を区別して返す', async () => {
    const { tenantId, app, caseId } = await setup({ connectedOperations: ['case_planning'] })
    const CROSS_BORDER_VERSION = '0.0.0-draft'
    await call(
      app,
      '/consents',
      jsonRequest(
        'POST',
        { agreements: [{ kind: 'CROSS_BORDER_AI', version: CROSS_BORDER_VERSION }] },
        nextKey('idem-consent'),
      ),
    )
    const queuedRun = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest(
        'POST',
        { operation: 'case_planning', targetType: 'CASE', targetId: caseId },
        nextKey('idem-run'),
      ),
    )
    const waitingRun = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest(
        'POST',
        { operation: 'case_planning', targetType: 'CASE', targetId: caseId },
        nextKey('idem-run'),
      ),
    )
    const failedRun = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest(
        'POST',
        { operation: 'case_planning', targetType: 'CASE', targetId: caseId },
        nextKey('idem-run'),
      ),
    )
    await setRunStatus(
      tenantId,
      caseId,
      waitingRun.body.data.id as string,
      'WAITING_APPROVAL',
      { waitingFor: '提案の確認' },
    )
    await setRunStatus(tenantId, caseId, failedRun.body.data.id as string, 'FAILED', {
      failureReason: '処理を完了できませんでした。',
    })

    const response = await call(app, `/cases/${caseId}/overview`)
    assert.equal(response.body.data.aiConnected, true)
    assert.equal(response.body.data.recentAgentRuns.length, 3)
    const runs = response.body.data.recentAgentRuns as Json[]
    const queued = runs.find((run) => run.id === queuedRun.body.data.id)
    const waiting = runs.find((run) => run.id === waitingRun.body.data.id)
    const failed = runs.find((run) => run.id === failedRun.body.data.id)
    assert.ok(queued)
    assert.ok(waiting)
    assert.ok(failed)
    assert.equal(queued.status, 'QUEUED')
    assert.equal(queued.waiting, false)
    assert.equal(waiting.status, 'WAITING_APPROVAL')
    assert.equal(waiting.waiting, true)
    assert.equal(waiting.waitingFor, '提案の確認')
    assert.equal(waiting.failureReason, null)
    assert.equal(failed.status, 'FAILED')
    assert.equal(failed.waiting, false)
    assert.equal(failed.failureReason, '処理を完了できませんでした。')
  })

  it('参加していない利用者は概要を取得できない', async () => {
    const owner = await setup()
    await seedTenantMember(owner.tenantId, 'user-outsider')
    const outsider = buildApp(owner.tenantId, 'user-outsider', { ruleCatalog: REVIEWED_CATALOG })
    await agreeRequiredConsents(outsider)

    const response = await call(outsider, `/cases/${owner.caseId}/overview`)
    assert.equal(response.status, 404)
  })

  it('別 Case の情報が混ざらない', async () => {
    const { app, caseId } = await setup()
    await call(app, `/cases/${caseId}/tasks/initialize`, jsonRequest('POST', {}, nextKey('idem-init')))

    const another = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
    const response = await call(app, `/cases/${another.body.data.id}/overview`)

    assert.equal(response.body.data.totalTasks, 0)
    assert.equal(response.body.data.upcomingDeadlines.length, 0)
  })
})
