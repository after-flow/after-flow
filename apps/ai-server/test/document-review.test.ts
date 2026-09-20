import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentHash } from '../src/orchestration/context/builder.js'
import { assertDeliveredDocument, reviewExtraction } from '../src/orchestration/documents/review.js'
import type { ProcessedDocument } from '../src/orchestration/documents/review.js'
import { createDocumentReviewWorkflow } from '../src/infrastructure/mastra/workflows/document-review.js'

const scope = { caseId: 'case', runId: 'run', documentId: 'document', documentVersion: 2 }
function fixture(): ProcessedDocument {
  const pages = [{ number: 1, text: '契約番号: SYNTHETIC-123\n氏名: 架空太郎' }]
  return { ...scope, caseVersion: 4, artifactId: 'masked', artifactVersion: 3, inspectedDocumentVersion: 2, inspection: 'PASSED', maskingPolicyVersion: 'synthetic-v1',
    expiresAt: new Date(Date.now() + 60000).toISOString(), contentHash: contentHash(pages), pages,
    fields: [{ id: 'number', label: '契約番号', required: true, current: { value: 'CORRECTED-456', state: 'user_reported', corrected: true } }, { id: 'date', label: '日付', required: true, current: null }] }
}
const candidate = { fieldId: 'number', value: 'SYNTHETIC-123', page: 1, start: 0, end: 19, quote: '契約番号: SYNTHETIC-123' }
const extraction = { candidates: [candidate], unreadableFields: [] }

test('document workflow retains exact evidence and corrections as unconfirmed conflict, with missing required fields', async () => {
  const document = fixture(); let deliveries = 0
  const workflow = createDocumentReviewWorkflow({ signal: new AbortController().signal, guard: async () => {}, deliver: async () => { deliveries++; return document }, extract: async () => extraction })
  const result = await (await workflow.createRun()).start({ inputData: scope })
  assert.equal(result.status, 'success', JSON.stringify(result)); if (result.status !== 'success') assert.fail()
  assert.equal(deliveries, 2); assert.equal(result.result.candidates[0]?.difference, 'CONFLICT')
  assert.equal(result.result.candidates[0]?.state, 'extracted_candidate'); assert.equal(result.result.candidates[0]?.preservesCorrection, true)
  assert.deepEqual(result.result.missingFields, ['date']); assert.equal(document.fields[0]?.current?.value, 'CORRECTED-456')
})

test('document boundary refuses foreign case, stale inspection, expired or modified content, forged locations and unreadable assertions', () => {
  const document = fixture()
  for (const patch of [{ caseId: 'other' }, { documentVersion: 1 }, { inspectedDocumentVersion: 1 }, { inspection: 'PENDING' }, { expiresAt: '2020-01-01T00:00:00Z' }, { contentHash: contentHash('wrong') }]) {
    assert.throws(() => assertDeliveredDocument({ ...document, ...patch }, scope))
  }
  for (const patch of [{ page: 2 }, { value: 'invented' }, { start: 1 }, { fieldId: 'unrequested' }]) {
    assert.throws(() => reviewExtraction(document, { ...extraction, candidates: [{ ...candidate, ...patch }] }), /evidence/)
  }
  assert.throws(() => reviewExtraction(document, { ...extraction, unreadableFields: ['number'] }), /evidence/)
  assert.throws(() => reviewExtraction(document, { ...extraction, candidates: [candidate, candidate] }), /evidence/)
})

test('document workflow rejects concurrent correction and live delivery withdrawal after extraction', async () => {
  for (const revoke of [false, true]) {
    let calls = 0
    const document = fixture()
    const workflow = createDocumentReviewWorkflow({ signal: new AbortController().signal, guard: async () => {}, extract: async () => extraction,
      deliver: async () => { calls++; if (calls > 1 && revoke) throw new Error('Delivery revoked'); return calls > 1 ? { ...document, caseVersion: 5 } : document } })
    const result = await (await workflow.createRun()).start({ inputData: scope })
    assert.equal(result.status, 'failed')
  }
})
