import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import { serve } from '@hono/node-server'
import { artifactEnvelopeSchema } from '@aftercare/internal-contracts'
import type { DocumentInspector } from '../../src/application/ports/inspection.js'
import { InternalExecutionService } from '../../src/application/agent/internal-execution-service.js'
import { AgentResultIntake } from '../../src/application/chat/result-intake.js'
import { ProposalService } from '../../src/application/proposal/proposal-service.js'
import { taskProposalApplier } from '../../src/application/proposal/task-applier.js'
import { entityProposalAppliers } from '../../src/application/proposal/entity-appliers.js'
import { taskActionProposalAppliers } from '../../src/application/proposal/task-action-appliers.js'
import { ConsentService } from '../../src/application/consent/consent-service.js'
import { AccessService } from '../../src/application/authorization/case-access.js'
import { ContextVersionUnitOfWork } from '../../src/application/case/context-version-unit-of-work.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { collections } from '../../src/domain/shared/collections.js'
import type { AgentRunEntity } from '../../src/domain/agent/agent-run.js'
import type { DocumentEntity } from '../../src/domain/document/document.js'
import { LocalObjectStorage } from '../../src/infrastructure/storage/local-object-storage.js'
import { SignedExecutionAuthorization } from '../../src/infrastructure/identity/execution-authorization.js'
import { createExecutionApp } from '../../src/presentation/routes/internal/v1/execution.js'
import { buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import { describeFirestore, newTenantId, readRepository, unitOfWork } from './helpers/emulator.js'

const signingKey = 'synthetic-test-signing-key-not-a-production-secret'
const incoming = 'synthetic-incoming-service-identity'

const passingInspector: DocumentInspector = {
  id: 'test-double', version: '0.0.0',
  async inspect() { return { status: 'PASSED', findings: [], inspectorId: 'test-double', inspectorVersion: '0.0.0', maskedObjectKey: null } },
}

/** 中身は意味を持たない合成PDF。実在の通帳は使わない。 */
function syntheticPdf(): Uint8Array {
  return new Uint8Array([...Buffer.from('%PDF-1.7\n'), ...Buffer.from('synthetic'), 0x0a])
}

async function setup(t: import('node:test').TestContext) {
  const tenantId = newTenantId(), userId = 'owner'
  await seedTenantMember(tenantId, userId)
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'after-flow-analysis-'))
  const app = buildApp(tenantId, userId, {
    inspector: passingInspector, aiConnected: true, storageRoot,
    connectedOperations: ['document_analysis'],
  })
  const read = readRepository(), uow = new ContextVersionUnitOfWork(unitOfWork())
  const consent = new ConsentService(PLACEHOLDER_CATALOG, new AccessService(read), read, uow)
  const proposals = new ProposalService(new AccessService(read), read, uow, [taskProposalApplier, ...entityProposalAppliers, ...taskActionProposalAppliers])
  const storage = new LocalObjectStorage(storageRoot)
  const service = new InternalExecutionService(read, uow, consent, new AgentResultIntake(read, uow), proposals,
    { rejectDraftDefinitions: false, storage })
  const authorization = new SignedExecutionAuthorization(signingKey)
  app.route('/internal/v1', createExecutionApp({ service, authorization, serviceCredential: incoming }))

  await call(app, '/consents', jsonRequest('POST', { agreements: PLACEHOLDER_CATALOG.documents.map(d => ({ kind: d.kind, version: d.version })) }))
  const created = await call(app, '/cases', jsonRequest('POST', { deceasedName: '架空人物', dateOfDeath: '2026-01-01', ownerName: '架空', relationshipToDeceased: '家族' }))
  assert.equal(created.status, 201)
  const caseId = created.body.data.id as string

  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  if (!server.listening) await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close(e => e ? reject(e) : resolve())
  }))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  async function uploadDocument(kind: string): Promise<Record<string, any>> {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(syntheticPdf())], `${kind}.pdf`, { type: 'application/pdf' }))
    form.append('kind', kind)
    const response = await app.request(`http://localhost/api/v1/cases/${caseId}/documents`, {
      method: 'POST', body: form, headers: { 'Idempotency-Key': randomUUID() },
    })
    assert.equal(response.status, 201)
    return (await response.json() as any).data
  }

  async function acceptAnalysis(documentId: string) {
    const accepted = await call(app, `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', { operation: 'document_analysis', targetType: 'DOCUMENT', targetId: documentId }))
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
    const run = (await read.get<AgentRunEntity>(tenantId, { collection: collections.agentRuns, caseId, id: accepted.body.data.id }))!
    const claims = await service.dispatchClaims(tenantId, caseId, run.id, run.currentJobId!)
    const token = await authorization.issue(claims)
    return { run, claims, token }
  }

  async function request(exec: { claims: { runId: string; jobId: string; executionAttempt: string }; token: string }, path: string, body?: unknown) {
    const now = Math.floor(Date.now() / 1000)
    const response = await fetch(`${baseUrl}/internal/v1/runs/${exec.claims.runId}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${incoming}`, 'X-Execution-Authorization': exec.token,
        'X-Request-Id': randomUUID(), 'X-Job-Id': exec.claims.jobId, 'X-Execution-Attempt': exec.claims.executionAttempt,
        'X-Issued-At': String(now), 'X-Expires-At': String(now + 60), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() as any }
  }

  return { tenantId, userId, caseId, app, service, authorization, read, uow, uploadDocument, acceptAnalysis, request }
}

describeFirestore('書類の読み取り（document_analysis, #196）', () => {
  it('登録から解析の受付・書類配送・抽出候補の提案・完了までを一通り検証する', async t => {
    const h = await setup(t)
    const doc = await h.uploadDocument('BANK_STATEMENT')
    assert.equal(doc.inspection.status, 'PASSED')
    assert.equal(doc.analysis.canRequest, true)
    assert.deepEqual(doc.analysis.blockedReasons, [])

    // 未対応種別の書類は解析を受け付けない
    const other = await h.uploadDocument('OTHER')
    const rejected = await call(h.app, `/cases/${h.caseId}/agent-runs`,
      jsonRequest('POST', { operation: 'document_analysis', targetType: 'DOCUMENT', targetId: other.id }))
    assert.equal(rejected.status, 501)

    const exec = await h.acceptAnalysis(doc.id)
    assert.equal(exec.run.status, 'QUEUED')
    const queued = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(queued.analysisState, 'QUEUED')
    assert.equal(queued.agentRunId, exec.run.id)

    const contextResult = await h.request(exec, 'context')
    assert.equal(contextResult.status, 200, JSON.stringify(contextResult.body))
    const artifact = artifactEnvelopeSchema.parse(contextResult.body.data)
    assert.equal(artifact.content.documentId, doc.id)
    assert.equal(artifact.content.inspection, 'PASSED')
    assert.ok(Array.isArray(artifact.content.pages) && (artifact.content.pages as unknown[]).length >= 1)
    const fields = artifact.content.fields as { id: string; required: boolean }[]
    assert.ok(fields.some(f => f.id === 'institution'))
    assert.ok(fields.some(f => f.id === 'amount'))

    const documentVersion = artifact.content.documentVersion as number
    const proposalInput = {
      caseVersion: artifact.caseVersion, contextSnapshotId: artifact.contextSnapshotId,
      fencingToken: artifact.fencingToken, artifactVersion: artifact.artifactVersion, contentHash: artifact.contentHash,
      proposalId: 'extracted-asset-1', kind: 'ASSET_PROPOSAL' as const,
      title: '預金口座を財産として登録する', summary: '通帳の表紙から読み取りました。',
      payload: { operation: 'CREATE', fields: { name: '○○銀行 普通預金', kind: 'BANK', institution: '○○銀行', amount: 1_000_000, taxAttention: false, note: null } },
      // AI Serverには書類のファイル名を渡さないため、AIが付けるラベルは書類IDになる。
      basis: [{ type: 'DOCUMENT' as const, id: doc.id, version: documentVersion, label: doc.id }],
      assetDisposal: false,
    }
    const proposed = await h.request(exec, 'proposals', proposalInput)
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body))
    const approvalId = proposed.body.data.approvalId as string

    const result = await h.request(exec, 'result', {
      caseVersion: artifact.caseVersion, contextSnapshotId: artifact.contextSnapshotId,
      fencingToken: artifact.fencingToken, artifactVersion: artifact.artifactVersion, contentHash: artifact.contentHash,
      resultId: 'result-1', basis: [], kind: 'document_analysis', status: 'SUCCEEDED',
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))

    const finished = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(finished.analysisState, 'COMPLETED')

    const approval = await call(h.app, `/cases/${h.caseId}/approvals/${approvalId}`)
    assert.equal(approval.status, 200)
    assert.equal(approval.body.data.sourceDocumentId, doc.id)
    // 画面が「◯◯ から」と表示する根拠のラベルは、Backendが書類のファイル名に置き換える。
    const proposals = await call(h.app, `/cases/${h.caseId}/proposals`)
    const submitted = proposals.body.data.find((item: any) => item.id === approval.body.data.proposalId)
    assert.deepEqual(submitted.basis.map((item: any) => item.label), [doc.fileName])
    assert.equal(approval.body.data.status, 'PENDING')

    // 解析完了（analysisState更新）で書類の版は進んでいるが、承認は妨げられない
    // （書類根拠は版ではなく利用可否で判定する）。
    const approved = await call(h.app, `/cases/${h.caseId}/approvals/${approvalId}/approve`, jsonRequest('POST', {
      expectedVersion: approval.body.data.version, proposalVersion: approval.body.data.proposalVersion,
      payloadHash: approval.body.data.payloadHash,
    }))
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.equal(approved.body.data.status, 'APPROVED')
    assert.equal(approved.body.data.applicationStatus, 'APPLIED')

    const assets = await call(h.app, `/cases/${h.caseId}/assets`)
    assert.equal(assets.status, 200)
    assert.ok(assets.body.data.some((asset: any) => asset.institution === '○○銀行'))
  })

  it('書類を一覧から外すと、その書類から届いた承認待ちの確認を失効させる', async t => {
    // 失効させないと、承認も却下もできない確認が「AIからの確認」に残り続ける。
    const h = await setup(t)
    const doc = await h.uploadDocument('BANK_STATEMENT')
    const exec = await h.acceptAnalysis(doc.id)
    const artifact = artifactEnvelopeSchema.parse((await h.request(exec, 'context')).body.data)
    const proposed = await h.request(exec, 'proposals', {
      caseVersion: artifact.caseVersion, contextSnapshotId: artifact.contextSnapshotId,
      fencingToken: artifact.fencingToken, artifactVersion: artifact.artifactVersion, contentHash: artifact.contentHash,
      proposalId: 'extracted-asset-1', kind: 'ASSET_PROPOSAL' as const, title: '預金口座を財産として登録する', summary: '書類から読み取りました。',
      payload: { operation: 'CREATE', fields: { name: '○○銀行', kind: 'BANK', institution: '○○銀行', amount: 1_000, taxAttention: false, note: null } },
      basis: [{ type: 'DOCUMENT' as const, id: doc.id, version: artifact.content.documentVersion as number, label: doc.id }], assetDisposal: false,
    })
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body))
    const approvalId = proposed.body.data.approvalId as string

    const current = await call(h.app, `/cases/${h.caseId}/documents/${doc.id}`)
    const archived = await call(h.app, `/cases/${h.caseId}/documents/${doc.id}/archive`, jsonRequest('POST', { expectedVersion: current.body.data.version }))
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    const approval = await call(h.app, `/cases/${h.caseId}/approvals/${approvalId}`)
    assert.equal(approval.body.data.status, 'EXPIRED')
  })

  it('取消したRunは書類を解析中のまま固定せず、新たな依頼を受け付けられる', async t => {
    const h = await setup(t)
    const doc = await h.uploadDocument('BANK_STATEMENT')
    const exec = await h.acceptAnalysis(doc.id)

    // 依頼直後は解析中で、再依頼は拒否される
    const duringAnalysis = await call(h.app, `/cases/${h.caseId}/documents/${doc.id}`)
    assert.ok(duringAnalysis.body.data.analysis.blockedReasons.includes('ALREADY_IN_PROGRESS'))
    const rejected = await call(h.app, `/cases/${h.caseId}/agent-runs`,
      jsonRequest('POST', { operation: 'document_analysis', targetType: 'DOCUMENT', targetId: doc.id }))
    assert.equal(rejected.status, 409)

    // 取消すると書類はFAILEDへ戻り、新たな依頼を受け付けられる（取消したRun自体はretry対象外）
    const cancelled = await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}/cancel`,
      jsonRequest('POST', { expectedVersion: exec.run.version }))
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    const afterCancel = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(afterCancel.analysisState, 'FAILED')

    const afterCancelView = await call(h.app, `/cases/${h.caseId}/documents/${doc.id}`)
    assert.equal(afterCancelView.body.data.analysis.canRequest, true)
    assert.ok(!afterCancelView.body.data.analysis.blockedReasons.includes('ALREADY_IN_PROGRESS'))

    const restarted = await call(h.app, `/cases/${h.caseId}/agent-runs`,
      jsonRequest('POST', { operation: 'document_analysis', targetType: 'DOCUMENT', targetId: doc.id }))
    assert.equal(restarted.status, 202, JSON.stringify(restarted.body))
    const afterRestart = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(afterRestart.analysisState, 'QUEUED')
    assert.equal(afterRestart.agentRunId, restarted.body.data.id)
  })

  it('AIが失敗を報告したRunはretryで同じ書類の解析をやり直せる', async t => {
    const h = await setup(t)
    const doc = await h.uploadDocument('BANK_STATEMENT')
    const exec = await h.acceptAnalysis(doc.id)
    const contextResult = await h.request(exec, 'context')
    const artifact = artifactEnvelopeSchema.parse(contextResult.body.data)

    const failed = await h.request(exec, 'result', {
      caseVersion: artifact.caseVersion, contextSnapshotId: artifact.contextSnapshotId,
      fencingToken: artifact.fencingToken, artifactVersion: artifact.artifactVersion, contentHash: artifact.contentHash,
      resultId: 'result-failed', basis: [], kind: 'document_analysis', status: 'FAILED',
    })
    assert.equal(failed.status, 200, JSON.stringify(failed.body))
    const afterFailure = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(afterFailure.analysisState, 'FAILED')

    const failedRun = (await h.read.get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: exec.run.id }))!
    assert.equal(failedRun.status, 'FAILED')
    const retried = await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}/retry`,
      jsonRequest('POST', { expectedVersion: failedRun.version }))
    assert.equal(retried.status, 202, JSON.stringify(retried.body))
    const afterRetry = (await h.read.get<DocumentEntity>(h.tenantId, { collection: collections.documents, caseId: h.caseId, id: doc.id }))!
    assert.equal(afterRetry.analysisState, 'QUEUED')
    assert.equal(afterRetry.agentRunId, exec.run.id)
  })
})
