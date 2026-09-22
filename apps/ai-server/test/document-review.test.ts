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
  for (const patch of [{ page: 2 }, { value: 'invented' }, { quote: '契約番号: SYNTHETIC-999', value: 'SYNTHETIC-999' }, { fieldId: 'unrequested' }]) {
    assert.throws(() => reviewExtraction(document, { ...extraction, candidates: [{ ...candidate, ...patch }] }), /evidence/)
  }
  assert.throws(() => reviewExtraction(document, { ...extraction, unreadableFields: ['number'] }), /evidence/)
  assert.throws(() => reviewExtraction(document, { ...extraction, candidates: [candidate, candidate] }), /evidence/)
})

test('引用の位置はモデルの申告ではなく本文から求め、値の表記の揺れだけを吸収する', () => {
  const pages = [{ number: 1, text: '残高証明書\n架空信用金庫 本店営業部\n残高 1,234,567円\n架空信用金庫' }]
  const document = { ...fixture(), pages, contentHash: contentHash(pages),
    fields: [{ id: 'institution', label: '金融機関名', required: true, current: null }, { id: 'amount', label: '残高', required: true, current: null }] }
  // 実モデルで見られた申告位置のずれ。本文中の出現位置に直す。
  const review = reviewExtraction(document, { unreadableFields: [], candidates: [
    { fieldId: 'amount', value: '1234567円', page: 1, start: 36, end: 44, quote: '残高 1,234,567円' },
    { fieldId: 'institution', value: '架空信用金庫', page: 1, start: 40, end: 46, quote: '架空信用金庫' },
  ] })
  const amount = review.candidates[0]!
  assert.equal(pages[0]!.text.slice(amount.start, amount.end), '残高 1,234,567円')
  // 同じ引用が複数あれば、申告位置に最も近い出現を使う。
  const institution = review.candidates[1]!
  assert.equal(institution.start, pages[0]!.text.lastIndexOf('架空信用金庫'))
  assert.deepEqual(review.missingFields, [])
  // 本文に無い引用、引用に無い値は、位置を探し直しても根拠にしない。
  for (const forged of [{ quote: '架空銀行 本店', value: '架空銀行' }, { quote: '架空信用金庫', value: '架空銀行' }]) {
    assert.throws(() => reviewExtraction(document, { unreadableFields: [], candidates: [{ fieldId: 'institution', page: 1, start: 0, end: 5, ...forged }] }), /evidence/)
  }
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
