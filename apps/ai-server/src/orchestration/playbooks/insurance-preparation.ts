import { z } from 'zod'
import { internalId } from '@aftercare/internal-contracts'
import { contentHash } from '../context/builder.js'
import type { ProposalDraft } from '../actions/contracts.js'

const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const refSchema = z.object({ id: internalId, version: z.number().int().positive() }).strict()
export const insuranceProcedureSchema = z.object({
  id: internalId, version: internalId, institution: z.string().min(1).max(200), reviewReference: z.string().min(1).max(500),
  reviewedAt: z.string().datetime(), expiresAt: z.string().datetime(), sourceIds: z.array(internalId).min(1).max(10),
  requiredFields: z.array(z.object({ id: internalId, label: z.string().min(1).max(120) }).strict()).min(1).max(20),
  requiredDocuments: z.array(z.object({ id: internalId, label: z.string().min(1).max(120) }).strict()).min(1).max(20),
}).strict()
export const insuranceContextSchema = z.object({
  caseId: internalId, runId: internalId, caseVersion: z.number().int().positive(),
  task: refSchema.extend({ title: z.string().min(1).max(120), requiredDocumentIds: z.array(internalId).max(20) }).strict(),
  contract: refSchema.extend({ provider: z.string().min(1).max(200) }).strict(),
  facts: z.array(z.object({ id: internalId, value: z.string().max(500).nullable(), state: z.enum(['confirmed', 'user_reported', 'extracted_candidate', 'unknown']) }).strict()).max(20),
  documents: z.array(refSchema.extend({ requirementId: internalId, contentHash: hash, inspection: z.literal('PASSED') }).strict()).max(20),
  sourceIds: z.array(internalId).max(20), unresolved: z.array(z.string().min(1).max(300)).max(20),
}).strict()
export const preparationReceiptSchema = z.object({ artifactId: internalId, artifactVersion: z.number().int().positive(), contentHash: hash }).strict()
export const preparationApprovalSchema = preparationReceiptSchema.extend({ status: z.enum(['APPROVED', 'REJECTED', 'PENDING']) }).strict()
export function buildInsurancePreparation(rawContext: unknown, rawProcedure: unknown) {
  const context = insuranceContextSchema.parse(rawContext); const procedure = insuranceProcedureSchema.parse(rawProcedure)
  if (Date.parse(procedure.reviewedAt) > Date.now() || Date.parse(procedure.expiresAt) <= Date.now() || procedure.institution !== context.contract.provider ||
    procedure.sourceIds.some(id => !context.sourceIds.includes(id))) throw new Error('Insurance procedure lacks current reviewed evidence')
  for (const records of [context.facts, context.documents, procedure.requiredFields, procedure.requiredDocuments]) {
    if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('Duplicate preparation identity')
  }
  if (new Set(context.documents.map(doc => doc.requirementId)).size !== context.documents.length ||
    context.documents.some(doc => !procedure.requiredDocuments.some(required => required.id === doc.requirementId)) ||
    procedure.requiredDocuments.some(doc => !context.task.requiredDocumentIds.includes(doc.id))) throw new Error('Required documents are not bound to the formal Task')
  const facts = procedure.requiredFields.map(field => ({ ...field, fact: context.facts.find(fact => fact.id === field.id) ?? null }))
  const documents = procedure.requiredDocuments.map(required => ({ ...required, document: context.documents.find(doc => doc.requirementId === required.id) ?? null }))
  const missingFields = facts.filter(item => !item.fact || item.fact.state !== 'confirmed' || !item.fact.value).map(item => item.id)
  const missingDocuments = documents.filter(item => !item.document).map(item => item.id)
  // No generated beneficiary, eligibility, application form or deadline. Every value comes from the scoped Backend view.
  const manifest = { kind: 'INSURANCE_PREPARATION' as const, schemaVersion: 1, caseId: context.caseId, caseVersion: context.caseVersion,
    task: context.task, contract: context.contract, procedure: { id: procedure.id, version: procedure.version, reviewReference: procedure.reviewReference },
    sourceIds: procedure.sourceIds, facts, documents, unresolved: context.unresolved,
    notice: '申請準備の確認資料です。外部提出・受理・給付を示すものではありません。' }
  const documentRequest: ProposalDraft | null = missingDocuments.length ? { kind: 'DOCUMENT_REQUEST', title: '保険手続きの不足書類の確認', summary: '確認済みの必要書類を揃えてください。',
    payload: { taskId: context.task.id, expectedTaskVersion: context.task.version, documents: procedure.requiredDocuments.filter(doc => missingDocuments.includes(doc.id)) },
    basis: [{ type: 'TASK', id: context.task.id, version: context.task.version, label: context.task.title }], assetDisposal: false } : null
  return { manifest, contentHash: contentHash(manifest), missingFields, missingDocuments, documentRequest }
}
/** Receipt and approval must be read from authenticated Backend APIs; a model cannot self-attest them. */
export function verifyInsurancePreparation(preparation: ReturnType<typeof buildInsurancePreparation>, rawReceipt: unknown, rawApproval: unknown) {
  if (contentHash(preparation.manifest) !== preparation.contentHash) throw new Error('Preparation manifest was modified')
  const receipt = rawReceipt == null ? null : preparationReceiptSchema.parse(rawReceipt)
  const approval = rawApproval == null ? null : preparationApprovalSchema.parse(rawApproval)
  if (preparation.manifest.documents.some(item => item.document === null)) return { state: 'WAITING_DOCUMENTS' as const, externalSubmission: false as const }
  const approved = receipt && approval && approval.status === 'APPROVED' && receipt.artifactId === approval.artifactId && receipt.artifactVersion === approval.artifactVersion &&
    receipt.contentHash === preparation.contentHash && approval.contentHash === preparation.contentHash
  return { state: approved && preparation.manifest.facts.every(item => item.fact?.state === 'confirmed' && !!item.fact.value) && !preparation.manifest.unresolved.length ? 'READY' as const : 'NEEDS_REVIEW' as const, externalSubmission: false as const }
}
