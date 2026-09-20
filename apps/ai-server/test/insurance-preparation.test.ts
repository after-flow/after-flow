import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInsurancePreparation, verifyInsurancePreparation } from '../src/orchestration/playbooks/insurance-preparation.js'
import { contentHash } from '../src/orchestration/context/builder.js'

function fixture() {
  const procedure = { id: 'synthetic-insurance', version: 'v1', institution: '架空保険', reviewReference: 'synthetic-only', reviewedAt: '2026-01-01T00:00:00Z', expiresAt: new Date(Date.now() + 60000).toISOString(),
    sourceIds: ['source'], requiredFields: [{ id: 'policy', label: '合成契約番号' }], requiredDocuments: [{ id: 'required', label: '合成必要書類' }] }
  const context = { caseId: 'case', runId: 'run', caseVersion: 1, task: { id: 'task', version: 1, title: '合成手続き', requiredDocumentIds: ['required'] },
    contract: { id: 'contract', version: 1, provider: '架空保険' }, facts: [{ id: 'policy', value: 'SYNTHETIC', state: 'confirmed' }],
    documents: [{ id: 'document', version: 1, requirementId: 'required', contentHash: contentHash('synthetic'), inspection: 'PASSED' }], sourceIds: ['source'], unresolved: [] }
  return { procedure, context }
}
test('insurance readiness requires approval of exact current artifact and never means external submission', () => {
  const { procedure, context } = fixture(); const prep = buildInsurancePreparation(context, procedure)
  const receipt = { artifactId: 'artifact', artifactVersion: 1, contentHash: prep.contentHash }
  assert.equal(verifyInsurancePreparation(prep, null, null).state, 'NEEDS_REVIEW')
  assert.deepEqual(verifyInsurancePreparation(prep, receipt, { ...receipt, status: 'APPROVED' }), { state: 'READY', externalSubmission: false })
  for (const patch of [{ artifactVersion: 2 }, { contentHash: contentHash('old') }, { artifactId: 'other' }, { status: 'REJECTED' }]) {
    assert.equal(verifyInsurancePreparation(prep, receipt, { ...receipt, status: 'APPROVED', ...patch }).state, 'NEEDS_REVIEW')
  }
  const changed = buildInsurancePreparation({ ...context, documents: [{ ...context.documents[0], version: 2 }] }, procedure)
  assert.equal(verifyInsurancePreparation(changed, receipt, { ...receipt, status: 'APPROVED' }).state, 'NEEDS_REVIEW')
})
test('missing documents produce a proposal and missing or candidate facts never become ready', () => {
  const { procedure, context } = fixture()
  const missing = buildInsurancePreparation({ ...context, documents: [] }, procedure)
  assert.equal(verifyInsurancePreparation(missing, null, null).state, 'WAITING_DOCUMENTS')
  assert.equal(missing.documentRequest?.kind, 'DOCUMENT_REQUEST'); assert.deepEqual(missing.documentRequest?.payload.documents, procedure.requiredDocuments)
  for (const state of ['unknown', 'user_reported', 'extracted_candidate']) {
    const prep = buildInsurancePreparation({ ...context, facts: [{ ...context.facts[0], state }] }, procedure)
    const receipt = { artifactId: 'artifact', artifactVersion: 1, contentHash: prep.contentHash }
    assert.equal(verifyInsurancePreparation(prep, receipt, { ...receipt, status: 'APPROVED' }).state, 'NEEDS_REVIEW')
  }
  assert.throws(() => buildInsurancePreparation({ ...context, contract: { ...context.contract, provider: '別機関' } }, procedure))
  assert.throws(() => buildInsurancePreparation({ ...context, documents: [{ ...context.documents[0], inspection: 'PENDING' }] }, procedure))
  assert.throws(() => buildInsurancePreparation(context, { ...procedure, expiresAt: '2020-01-01T00:00:00Z' }))
})

test('native preparation workflow refuses a changed or cross-case live view', async () => {
  const { createInsurancePreparationWorkflow } = await import('../src/infrastructure/mastra/workflows/insurance-preparation.js')
  const { procedure, context } = fixture()
  for (const mode of ['stable', 'changed', 'foreign']) {
    let calls = 0
    const workflow = createInsurancePreparationWorkflow({ procedure, signal: new AbortController().signal, guard: async () => {}, load: async () => {
      calls++; return { context: { ...context, ...(mode === 'foreign' ? { caseId: 'other' } : {}), ...(mode === 'changed' && calls > 1 ? { caseVersion: 2 } : {}) }, receipt: null, approval: null }
    } })
    const result = await (await workflow.createRun()).start({ inputData: { caseId: 'case', runId: 'run' } })
    assert.equal(result.status, mode === 'stable' ? 'success' : 'failed')
    if (result.status === 'success') assert.equal(result.result.state, 'NEEDS_REVIEW')
  }
})
