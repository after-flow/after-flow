import { z } from 'zod'
import { contentHash } from '../src/orchestration/context/builder.js'

export const fixtureInputSchema = z.object({ family: z.enum(['document', 'insurance', 'insight']), data: z.record(z.string(), z.unknown()) }).strict()
export const expectationSchema = z.object({ state: z.string(), error: z.string().optional(), pairs: z.array(z.string()).optional() }).strict()
export type FixtureInput = z.infer<typeof fixtureInputSchema>
export interface EvalCase { id: string; split: 'development' | 'holdout'; severity: 'critical' | 'quality'; input: FixtureInput; expected: z.infer<typeof expectationSchema> }
const cases: EvalCase[] = []
const add = (id: string, family: FixtureInput['family'], data: Record<string, unknown>, expected: EvalCase['expected'], severity: EvalCase['severity'] = 'critical') => {
  cases.push({ id, split: cases.length % 4 === 3 ? 'holdout' : 'development', severity, input: { family, data }, expected })
}
const scope = { caseId: 'case', runId: 'run', documentId: 'document', documentVersion: 2 }
const pages = [{ number: 1, text: '番号: SYNTHETIC-123' }]
const document = { ...scope, caseVersion: 4, artifactId: 'masked', artifactVersion: 3, inspectedDocumentVersion: 2, inspection: 'PASSED', maskingPolicyVersion: 'synthetic-v1', expiresAt: '2099-01-01T00:00:00Z', contentHash: contentHash(pages), pages,
  fields: [{ id: 'number', label: '合成番号', required: true, current: null }] }
const candidate = { fieldId: 'number', value: 'SYNTHETIC-123', page: 1, start: 0, end: 17, quote: pages[0]!.text }
const extraction = { candidates: [candidate], unreadableFields: [] }
const docData = { scope, document, extraction }
add('doc-valid', 'document', docData, { state: 'NEEDS_REVIEW', pairs: ['number=SYNTHETIC-123'] }, 'quality')
add('doc-missing', 'document', { ...docData, extraction: { candidates: [], unreadableFields: [] } }, { state: 'MISSING', pairs: [] }, 'quality')
add('doc-correction', 'document', { ...docData, document: { ...document, fields: [{ ...document.fields[0], current: { value: 'CORRECTED', state: 'user_reported', corrected: true } }] } }, { state: 'CONFLICT', pairs: ['number=SYNTHETIC-123'] })
for (const [id, patch] of Object.entries({ foreign: { caseId: 'other' }, stale: { documentVersion: 1 }, inspection: { inspectedDocumentVersion: 1 }, expired: { expiresAt: '2020-01-01T00:00:00Z' }, hash: { contentHash: contentHash('wrong') } })) {
  add(`doc-${id}`, 'document', { ...docData, document: { ...document, ...patch } }, { state: 'REJECTED', error: 'DELIVERY' })
}
for (const [id, patch] of Object.entries({ page: { page: 2 }, location: { start: 1 }, invented: { value: 'invented' }, field: { fieldId: 'other' } })) {
  add(`doc-${id}`, 'document', { ...docData, extraction: { ...extraction, candidates: [{ ...candidate, ...patch }] } }, { state: 'REJECTED', error: 'EVIDENCE' })
}
add('doc-uninspected', 'document', { ...docData, document: { ...document, inspection: 'PENDING' } }, { state: 'REJECTED', error: 'SCHEMA' })
add('doc-unreadable', 'document', { ...docData, extraction: { candidates: [], unreadableFields: ['number'] } }, { state: 'MISSING', pairs: [] }, 'quality')
const procedure = { id: 'insurance', version: 'v1', institution: '架空保険', reviewReference: 'synthetic-only', reviewedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', sourceIds: ['source'], requiredFields: [{ id: 'policy', label: '合成番号' }], requiredDocuments: [{ id: 'required', label: '合成資料' }] }
const context = { caseId: 'case', runId: 'run', caseVersion: 1, task: { id: 'task', version: 1, title: '合成手続き', requiredDocumentIds: ['required'] }, contract: { id: 'contract', version: 1, provider: '架空保険' }, facts: [{ id: 'policy', value: 'SYNTHETIC', state: 'confirmed' }], documents: [{ id: 'doc', version: 1, requirementId: 'required', contentHash: contentHash('fixture'), inspection: 'PASSED' }], sourceIds: ['source'], unresolved: [] }
add('insurance-ready', 'insurance', { context, procedure, approval: 'exact' }, { state: 'READY' }, 'quality')
for (const approval of ['none', 'wrong-version', 'wrong-hash', 'rejected']) add(`insurance-${approval}`, 'insurance', { context, procedure, approval }, { state: 'NEEDS_REVIEW' })
for (const state of ['unknown', 'user_reported', 'extracted_candidate']) add(`insurance-${state}`, 'insurance', { context: { ...context, facts: [{ ...context.facts[0], state }] }, procedure, approval: 'exact' }, { state: 'NEEDS_REVIEW' })
add('insurance-missing-doc', 'insurance', { context: { ...context, documents: [] }, procedure, approval: 'exact' }, { state: 'WAITING_DOCUMENTS' }, 'quality')
add('insurance-conflict', 'insurance', { context: { ...context, unresolved: ['合成矛盾'] }, procedure, approval: 'exact' }, { state: 'NEEDS_REVIEW' })
add('insurance-foreign', 'insurance', { context: { ...context, contract: { ...context.contract, provider: 'other' } }, procedure }, { state: 'REJECTED', error: 'PROCEDURE' })
add('insurance-expired', 'insurance', { context, procedure: { ...procedure, expiresAt: '2020-01-01T00:00:00Z' } }, { state: 'REJECTED', error: 'PROCEDURE' })
const expected = { caseId: 'case', caseVersion: 3, taskId: 'task', taskVersion: 2 }
const event = { id: 'event', caseId: 'case', caseVersion: 3, expiresAt: '2099-01-01T00:00:00Z', task: { id: 'task', version: 2, title: '合成手続き' }, kind: 'DOCUMENTS_MISSING', documents: [{ id: 'required', label: '合成書類' }] }
add('insight-missing', 'insight', { event, expected }, { state: 'DRAFT' }, 'quality')
add('insight-unsupported', 'insight', { event: { id: event.id, caseId: event.caseId, caseVersion: event.caseVersion, expiresAt: event.expiresAt, task: event.task, kind: 'CASE_CHANGED' }, expected }, { state: 'UNSUPPORTED' }, 'quality')
for (const [id, patch] of Object.entries({ foreign: { caseId: 'other' }, stale: { caseVersion: 2 }, expired: { expiresAt: '2020-01-01T00:00:00Z' }, task: { task: { ...event.task, version: 1 } } })) add(`insight-${id}`, 'insight', { event: { ...event, ...patch }, expected }, { state: 'REJECTED', error: 'EVENT' })
export const dataset = Object.freeze(cases)
export const datasetVersion = contentHash(dataset)
