import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import type { TestContext } from 'node:test'
import { serve } from '@hono/node-server'
import { artifactEnvelopeSchema } from '@aftercare/internal-contracts'
import type { ContextArtifact, ExecutionClaims, ExecutionSnapshotStatus } from '@aftercare/internal-contracts'
import { InternalExecutionService } from '../../src/application/agent/internal-execution-service.js'
import { OutboxDispatcher } from '../../src/application/agent/outbox-dispatcher.js'
import { RunReconciler } from '../../src/application/agent/run-reconciler.js'
import { AccessService } from '../../src/application/authorization/case-access.js'
import { AgentResultIntake } from '../../src/application/chat/result-intake.js'
import { ConsentService } from '../../src/application/consent/consent-service.js'
import { ContextVersionUnitOfWork } from '../../src/application/case/context-version-unit-of-work.js'
import { entityProposalAppliers } from '../../src/application/proposal/entity-appliers.js'
import { ProposalService } from '../../src/application/proposal/proposal-service.js'
import { taskActionProposalAppliers } from '../../src/application/proposal/task-action-appliers.js'
import { taskProposalApplier } from '../../src/application/proposal/task-applier.js'
import type { ExecutionSnapshots } from '../../src/application/ports/execution-snapshots.js'
import type { AgentRunEntity } from '../../src/domain/agent/agent-run.js'
import type { CaseLeaseEntity } from '../../src/domain/agent/case-lease.js'
import type { WaitRequestEntity } from '../../src/domain/agent/wait-request.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { INFRASTRUCTURE_COLLECTIONS, collections } from '../../src/domain/shared/collections.js'
import { ScopedHttpAgentJobClient } from '../../src/infrastructure/agent/scoped-http-agent-client.js'
import { SignedExecutionAuthorization } from '../../src/infrastructure/identity/execution-authorization.js'
import { createExecutionApp } from '../../src/presentation/routes/internal/v1/execution.js'
import { buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import { agentRunEvents, describeFirestore, firestore, newTenantId, readRepository, unitOfWork } from './helpers/emulator.js'
import { startFakeAiServer } from './helpers/fake-ai-server.js'

const signingKey = 'synthetic-test-signing-key-not-a-production-secret'
const incoming = 'synthetic-incoming-service-identity'
const outgoing = 'synthetic-outgoing-service-identity'

const proof = (a: ContextArtifact) => ({
  caseVersion: a.caseVersion,
  contextSnapshotId: a.contextSnapshotId,
  artifactVersion: a.artifactVersion,
  contentHash: a.contentHash,
  fencingToken: a.fencingToken,
})

/**
 * AI が所有する Snapshot の状態を置き換えられるようにしたもの。
 *
 * Snapshot の本文は扱わない。Backend が照合するのは、待機している実行が
 * AI 側でも保存済みかどうかだけ。
 */
function controllableSnapshots(): ExecutionSnapshots & {
  set(state: ExecutionSnapshotStatus['state'], snapshotId: string | null): void
  calls: number
} {
  let state: ExecutionSnapshotStatus['state'] = 'MISSING'
  let snapshotId: string | null = null
  return {
    calls: 0,
    set(nextState, nextSnapshotId) {
      state = nextState
      snapshotId = nextSnapshotId
    },
    async status(input) {
      this.calls += 1
      return {
        runId: input.runId,
        jobId: input.jobId,
        executionAttempt: input.executionAttempt,
        waitRequestId: input.waitRequestId,
        state,
        snapshotId,
      }
    },
  }
}

async function setup(t: TestContext) {
  const tenantId = newTenantId()
  const userId = 'owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, { connectedOperations: ['case_planning'] })

  const read = readRepository()
  const uow = new ContextVersionUnitOfWork(unitOfWork())
  const consent = new ConsentService(PLACEHOLDER_CATALOG, new AccessService(read), read, uow)
  const proposals = new ProposalService(new AccessService(read), read, uow, [
    taskProposalApplier,
    ...entityProposalAppliers,
    ...taskActionProposalAppliers,
  ])
  const service = new InternalExecutionService(read, uow, consent, new AgentResultIntake(read, uow), proposals)
  const authorization = new SignedExecutionAuthorization(signingKey)
  app.route('/internal/v1', createExecutionApp({ service, authorization, serviceCredential: incoming }))

  await call(
    app,
    '/consents',
    jsonRequest('POST', {
      agreements: PLACEHOLDER_CATALOG.documents.map((d) => ({ kind: d.kind, version: d.version })),
    }),
  )
  const created = await call(
    app,
    '/cases',
    jsonRequest('POST', {
      deceasedName: '架空人物',
      dateOfDeath: '2026-01-01',
      ownerName: '架空',
      relationshipToDeceased: '家族',
    }),
  )
  assert.equal(created.status, 201)
  const caseId = created.body.data.id as string

  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  if (!server.listening) await once(server, 'listening')
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        if ('closeAllConnections' in server) server.closeAllConnections()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  )
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const ai = await startFakeAiServer({ expectedToken: outgoing, protocol: 'scoped' })
  t.after(() => ai.close())
  const client = new ScopedHttpAgentJobClient(
    { baseUrl: ai.url, serviceToken: outgoing, audience: 'ai-server', timeoutMs: 1000 },
    service,
    authorization,
  )

  const snapshots = controllableSnapshots()
  const reconciler = new RunReconciler(read, uow, service, snapshots)
  // 業務イベントは Backend だけが解釈する。汎用 payload を AI へ転送しない。
  const dispatcher = new OutboxDispatcher(firestore(), client, consent, 0, reconciler)

  async function accept() {
    const accepted = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', { operation: 'case_planning', targetId: caseId, targetType: 'CASE' }),
    )
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
    const run = (await read.get<AgentRunEntity>(tenantId, {
      collection: collections.agentRuns,
      caseId,
      id: accepted.body.data.id,
    }))!
    const job = {
      eventId: run.currentJobId!,
      tenantId,
      caseId,
      type: 'agent.case_planning',
      payload: { runId: run.id },
      attempt: 1,
    }
    assert.equal((await client.deliver(job)).status, 'ACCEPTED')
    const dispatch = ai.dispatches.at(-1)!
    const claims = await authorization.verify(dispatch.executionAuthorization)
    return { run, job, dispatch, claims }
  }

  type Execution = Awaited<ReturnType<typeof accept>>

  async function request(
    exec: { dispatch: { executionAuthorization: string }; claims: ExecutionClaims },
    path: string,
    body?: unknown,
  ) {
    const now = Math.floor(Date.now() / 1000)
    const response = await fetch(`${baseUrl}/internal/v1/runs/${exec.claims.runId}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${incoming}`,
        'X-Execution-Authorization': exec.dispatch.executionAuthorization,
        'X-Request-Id': randomUUID(),
        'X-Job-Id': exec.claims.jobId,
        'X-Execution-Attempt': exec.claims.executionAttempt,
        'X-Issued-At': String(now),
        'X-Expires-At': String(now + 60),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as any }
  }

  async function context(exec: Execution) {
    const result = await request(exec, 'context')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return artifactEnvelopeSchema.parse(result.body.data)
  }

  /** 提案を出して承認待ちの待機要求を作る。 */
  async function propose(exec: Execution, artifact: ContextArtifact, actionId = 'action-1') {
    const result = await request(exec, 'proposals', {
      ...proof(artifact),
      proposalId: actionId,
      kind: 'TASK_PROPOSAL',
      title: '架空の手続きを追加する',
      payload: { title: '架空の手続き', stage: 'immediate', category: '行政手続き' },
      basis: [],
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body.data as {
      proposalId: string
      approvalId: string
      proposalVersion: number
      payloadHash: string
      waitRequestId: string
      applicationStatus: string
    }
  }

  async function approve(approvalId: string) {
    const approval = await call(app, `/cases/${caseId}/approvals/${approvalId}`)
    assert.equal(approval.status, 200, JSON.stringify(approval.body))
    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approvalId}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.body.data.version,
        proposalVersion: approval.body.data.proposalVersion,
        payloadHash: approval.body.data.payloadHash,
      }),
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.data
  }

  async function reject(approvalId: string) {
    const approval = await call(app, `/cases/${caseId}/approvals/${approvalId}`)
    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approvalId}/reject`,
      jsonRequest('POST', { expectedVersion: approval.body.data.version }),
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
  }

  /** 業務イベントを Inbox へ取り込む。AI への配送は行われない。 */
  async function drainOutbox() {
    for (let round = 0; round < 6; round += 1) {
      const result = await dispatcher.dispatchBatch(tenantId, 50)
      if (result.delivered.length === 0 && result.retrying.length === 0 && result.blocked.length === 0) return
    }
  }

  const loadRun = async (runId: string) =>
    (await read.get<AgentRunEntity>(tenantId, { collection: collections.agentRuns, caseId, id: runId }))!
  const loadWait = async (waitId: string) =>
    await read.get<WaitRequestEntity>(tenantId, { collection: collections.waitRequests, caseId, id: waitId })
  const loadLease = async () =>
    await read.get<CaseLeaseEntity>(tenantId, { collection: collections.caseLeases, caseId, id: 'writer' })

  async function outboxOfType(type: string) {
    const snapshot = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', type)
      .get()
    return snapshot.docs
  }

  return {
    tenantId,
    caseId,
    app,
    read,
    uow,
    service,
    consent,
    snapshots,
    reconciler,
    accept,
    request,
    context,
    propose,
    approve,
    reject,
    drainOutbox,
    loadRun,
    loadWait,
    loadLease,
    outboxOfType,
  }
}

describeFirestore('待機と再開', () => {
  it('提案の提出で待機要求が作られ、結果の提出を拒否する', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    assert.ok(proposal.waitRequestId, '承認待ちの待機要求が作られていない')
    assert.equal(proposal.applicationStatus, 'NOT_APPLIED')

    const wait = await env.loadWait(proposal.waitRequestId)
    // Snapshot の保存通知が来るまでは待機として確定しない。
    assert.equal(wait?.state, 'PENDING_SNAPSHOT')

    const result = await env.request(exec, 'result', {
      ...proof(artifact),
      resultId: 'result-1',
      kind: 'case_planning',
      status: 'SUCCEEDED',
    })
    // 待機が残っている実行から完了の結果を受け取らない。
    assert.equal(result.status, 409)
    assert.equal(result.body.error.details.reason, 'WAIT_OUTSTANDING')
  })

  it('Snapshot保存の通知で待機になり、書き込み権を解放する', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    const leaseBefore = await env.loadLease()
    assert.equal(leaseBefore?.holderRunId, exec.run.id)

    const event = await env.request(exec, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })
    assert.equal(event.status, 200, JSON.stringify(event.body))

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'WAITING_APPROVAL')
    assert.equal(run.waitingFor, proposal.waitRequestId)

    const wait = await env.loadWait(proposal.waitRequestId)
    assert.equal(wait?.state, 'WAITING')
    assert.equal(wait?.snapshotId, 'snapshot-1')

    // 待っている間は書き込み権を持たない。他の実行を塞がない。
    const leaseAfter = await env.loadLease()
    assert.equal(leaseAfter?.holderRunId, null)

    // 公開可能な待機履歴（Issue #125）。同じeventIdの再送は内部APIの
    // receiptで弾かれるため、この関数を2回目は呼ばない前提のfnになる。
    const events = await agentRunEvents(env.tenantId, env.caseId, exec.run.id)
    const waiting = events.find((e) => e.kind === 'WAITING')
    assert.ok(waiting, 'WAITINGイベントが記録されていない')
    assert.equal(waiting!.eventId, 'event-waiting-1')
    assert.equal(waiting!.status, 'WAITING_APPROVAL')
    assert.equal(waiting!.detail.waitRequestId, proposal.waitRequestId)
    assert.equal(waiting!.detail.conditionKind, 'APPROVAL')
  })

  it('承認がSnapshot保存前に届いても、後で一度だけ再開する', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    // Snapshot の保存通知より先に人が承認する。
    await env.approve(proposal.approvalId)
    await env.drainOutbox()

    const pending = await env.loadWait(proposal.waitRequestId)
    assert.equal(pending?.state, 'PENDING_SNAPSHOT', '先行した承認で待機が消えている')

    // AI 側では Snapshot の保存が完了していた。
    env.snapshots.set('WAITING', 'snapshot-1')
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const wait = await env.loadWait(proposal.waitRequestId)
    assert.equal(wait?.state, 'RESUME_QUEUED')
    assert.ok(wait?.inboxId, '再開の根拠となった受信イベントが記録されていない')

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'QUEUED')
    assert.equal(run.attempt, exec.run.attempt + 1)
    assert.equal(run.pendingResume?.outcome, 'APPLIED')
    assert.equal(run.pendingResume?.kind, 'WAIT')
    assert.equal(run.activeWaitRequestId, null)

    // 何度照合しても再開は一度だけ。
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const resumes = await env.outboxOfType('agent.resume')
    assert.equal(resumes.length, 1, '再開が重複して積まれている')
    const after = await env.loadRun(exec.run.id)
    assert.equal(after.attempt, run.attempt, '照合のたびに試行が増えている')

    // 公開可能な再開履歴（Issue #125）。何度照合してもRESUMEDは増えない。
    const events = await agentRunEvents(env.tenantId, env.caseId, exec.run.id)
    const resumed = events.filter((e) => e.kind === 'RESUMED')
    assert.equal(resumed.length, 1, 'RESUMEDが重複して記録されている')
    assert.equal(resumed[0]!.status, 'QUEUED')
    assert.equal(resumed[0]!.attempt, run.attempt)
    assert.equal(resumed[0]!.detail.kind, 'WAIT')
    assert.equal(resumed[0]!.detail.outcome, 'APPLIED')
    assert.equal(resumed[0]!.detail.waitRequestId, proposal.waitRequestId)
  })

  it('却下でも再開し、結果を反映済みとしない', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.request(exec, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })
    await env.reject(proposal.approvalId)
    await env.drainOutbox()

    env.snapshots.set('WAITING', 'snapshot-1')
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'QUEUED')
    assert.equal(run.pendingResume?.outcome, 'REJECTED')
    assert.equal((await env.outboxOfType('agent.resume')).length, 1)
  })

  it('待機中に再起動しても、別のプロセスが再開できる', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.request(exec, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })
    await env.approve(proposal.approvalId)
    await env.drainOutbox()

    // 別インスタンスを模す。保存済みの状態だけから再開できることを見る。
    const snapshots = controllableSnapshots()
    snapshots.set('WAITING', 'snapshot-1')
    const restarted = new RunReconciler(env.read, env.uow, env.service, snapshots)

    const outcome = await restarted.tick(env.tenantId)
    assert.equal(outcome.failed, 0, '照合に失敗した実行がある')

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'QUEUED')
    assert.equal(run.pendingResume?.snapshotId, 'snapshot-1')
    assert.equal((await env.outboxOfType('agent.resume')).length, 1)
  })

  it('Snapshotが無い間は再開しない', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.approve(proposal.approvalId)
    await env.drainOutbox()

    // AI 側に保存が無い。ここで再開すると、再開先の状態が存在しない。
    env.snapshots.set('MISSING', null)
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const wait = await env.loadWait(proposal.waitRequestId)
    assert.equal(wait?.state, 'PENDING_SNAPSHOT')
    assert.equal((await env.outboxOfType('agent.resume')).length, 0)
  })

  it('承認が届くまでは再開しない', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.request(exec, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })

    env.snapshots.set('WAITING', 'snapshot-1')
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'WAITING_APPROVAL')
    assert.equal((await env.outboxOfType('agent.resume')).length, 0)
  })

  it('同じイベントを二度取り込んでも受信記録が増えない', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.approve(proposal.approvalId)
    await env.drainOutbox()
    await env.drainOutbox()

    const inbox = await firestore()
      .collection(`tenants/${env.tenantId}/cases/${env.caseId}/runInbox`)
      .get()
    const applied = inbox.docs.filter((doc) => doc.get('type') === 'proposal.applied')
    assert.equal(applied.length, 1)
  })

  it('待機中に同意が撤回されたら待機を取り消して停止する', async (t) => {
    const env = await setup(t)
    const exec = await env.accept()
    const artifact = await env.context(exec)
    const proposal = await env.propose(exec, artifact)

    await env.request(exec, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })
    await call(
      env.app,
      '/consents/revocations',
      jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }),
    )

    env.snapshots.set('WAITING', 'snapshot-1')
    await env.reconciler.reconcile(env.tenantId, env.caseId, exec.run.id)

    const run = await env.loadRun(exec.run.id)
    assert.equal(run.status, 'CANCELLED')
    assert.ok(run.failureReason)

    const wait = await env.loadWait(proposal.waitRequestId)
    assert.equal(wait?.state, 'CANCELLED')
    assert.equal((await env.outboxOfType('agent.resume')).length, 0)

    const lease = await env.loadLease()
    assert.equal(lease?.holderRunId, null)

    // 公開可能な取消履歴（Issue #125）。同意撤回によるCANCELLEDもイベントに残る。
    const events = await agentRunEvents(env.tenantId, env.caseId, exec.run.id)
    const cancelled = events.filter((e) => e.kind === 'CANCELLED')
    assert.equal(cancelled.length, 1, 'CANCELLEDイベントが記録されていない')
    assert.equal(cancelled[0]!.status, 'CANCELLED')
  })

  it('他の実行の承認を待たせない', async (t) => {
    const env = await setup(t)
    const first = await env.accept()
    const firstArtifact = await env.context(first)
    const proposal = await env.propose(first, firstArtifact)

    await env.request(first, 'events', {
      eventId: 'event-waiting-1',
      type: 'WAITING',
      waitRequestId: proposal.waitRequestId,
      snapshotId: 'snapshot-1',
    })

    // 別の実行が、自分のものではない承認を待とうとする。
    const second = await env.accept()
    const secondArtifact = await env.context(second)
    const result = await env.request(second, 'wait-requests', {
      ...proof(secondArtifact),
      waitRequestId: 'wait-from-another-run',
      condition: { kind: 'APPROVAL', approvalId: proposal.approvalId },
    })

    assert.equal(result.status, 403)
  })
})
