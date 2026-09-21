import { z } from 'zod'
import { collections } from '../../domain/shared/collections.js'
import type { TaskEntity } from '../../domain/task/task.js'
import type { EvidenceEntity } from '../../domain/task/evidence.js'
import type { DocumentEntity } from '../../domain/document/document.js'
import { isAllowedTransition } from '../../domain/task/transitions.js'
import { errors } from '../../shared/app-error.js'
import type { Tx } from '../ports/persistence.js'
import type { ProposalApplier } from './proposal-service.js'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const version = z.number().int().positive()
const target = { taskId: id, expectedTaskVersion: version }
const document = z.object({ id, version }).strict()
const requestSchema = z.object({ ...target,
  documents: z.array(z.object({ id, label: z.string().min(1).max(120) }).strict()).min(1).max(50),
}).strict().refine(value => new Set(value.documents.map(doc => doc.id)).size === value.documents.length)
const evidenceSchema = z.object({ ...target, label: z.string().min(1).max(120),
  kind: z.enum(['RECEIPT', 'NOTICE', 'PAYMENT', 'REGISTRATION', 'OTHER']),
  note: z.string().max(500).nullable(), document: document.nullable(),
}).strict()
const escalationSchema = z.object({ ...target, reason: z.string().min(1).max(2000),
  documents: z.array(document).max(20),
}).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw errors.validationFailed({ details: { reason: 'INVALID_PROPOSAL_PAYLOAD' } })
  return result.data
}
type Context = Parameters<ProposalApplier['apply']>[1]
async function targetTask(tx: Tx, context: Context, input: { taskId: string; expectedTaskVersion: number }) {
  const location = { collection: collections.tasks, caseId: context.caseId, id: input.taskId }
  const task = await tx.require<TaskEntity>(location)
  if (task.version !== input.expectedTaskVersion) {
    throw errors.conflict({ details: { reason: 'TARGET_VERSION_CHANGED' },
      internal: { staleProposalId: context.proposal.id, staleProposalEntityVersion: context.proposal.version } })
  }
  return { task, location }
}
async function verifyDocument(tx: Tx, caseId: string, ref: { id: string; version: number }) {
  const stored = await tx.require<DocumentEntity>({ collection: collections.documents, caseId, id: ref.id })
  if (stored.version !== ref.version) throw errors.conflict({ details: { reason: 'BASIS_VERSION_CHANGED' } })
  if (stored.archived || stored.storageState !== 'STORED') throw errors.preconditionFailed({ details: { reason: 'DOCUMENT_UNAVAILABLE' } })
}

export const taskActionProposalAppliers: ProposalApplier[] = [
  { kind: 'DOCUMENT_REQUEST', validate: value => { parse(requestSchema, value) }, async apply(tx, context) {
    const input = parse(requestSchema, context.proposal.payload)
    const { task, location } = await targetTask(tx, context, input)
    if (task.status !== 'WAITING_DOCUMENTS' && !isAllowedTransition('requestDocuments', task.status)) {
      throw errors.preconditionFailed({ details: { reason: 'INVALID_TRANSITION' } })
    }
    if (task.requiredDocuments.length + input.documents.length > 50
      || input.documents.some(doc => task.requiredDocuments.some(existing => existing.id === doc.id))) {
      throw errors.preconditionFailed({ details: { reason: 'DOCUMENT_REQUIREMENT_CONFLICT' } })
    }
    tx.update<TaskEntity>(location, task.version, { status: 'WAITING_DOCUMENTS',
      requiredDocuments: [...task.requiredDocuments, ...input.documents.map(doc => ({
        ...doc, documentId: null, source: context.proposal.source === 'AI' ? 'AI' as const : 'MANUAL' as const,
      }))] })
    tx.audit({ caseId: context.caseId, type: 'task.documents_requested_from_proposal',
      target: { collection: collections.tasks.name, id: task.id, version: task.version + 1 },
      detail: { proposalId: context.proposal.id, payloadHash: context.proposal.payloadHash } })
  } },
  { kind: 'EVIDENCE_PROPOSAL', validate: value => { parse(evidenceSchema, value) }, async apply(tx, context) {
    const input = parse(evidenceSchema, context.proposal.payload)
    const { task } = await targetTask(tx, context, input)
    if (input.document) await verifyDocument(tx, context.caseId, input.document)
    const id = `proposal-${context.proposal.id}-${context.proposal.proposalVersion}`
    tx.create<EvidenceEntity>({ collection: collections.evidence, caseId: context.caseId, id }, {
      id, taskId: task.id, label: input.label, kind: input.kind, note: input.note,
      documentId: input.document?.id ?? null, recordedBy: context.userId,
    })
    tx.audit({ caseId: context.caseId, type: 'evidence.applied_from_proposal',
      target: { collection: collections.evidence.name, id, version: 1 },
      detail: { proposalId: context.proposal.id, taskId: task.id, payloadHash: context.proposal.payloadHash } })
  } },
  { kind: 'ESCALATION_PROPOSAL', validate: value => { parse(escalationSchema, value) }, async apply(tx, context) {
    const input = parse(escalationSchema, context.proposal.payload)
    const { task, location } = await targetTask(tx, context, input)
    if (!isAllowedTransition('escalate', task.status)) throw errors.preconditionFailed({ details: { reason: 'INVALID_TRANSITION' } })
    for (const ref of input.documents) await verifyDocument(tx, context.caseId, ref)
    tx.update<TaskEntity>(location, task.version, { status: 'ESCALATED', escalation: {
      proposalId: context.proposal.id, reason: input.reason, documents: input.documents, contacted: false,
    } })
    tx.audit({ caseId: context.caseId, type: 'task.escalated_from_proposal',
      target: { collection: collections.tasks.name, id: task.id, version: task.version + 1 },
      detail: { proposalId: context.proposal.id, contacted: false, payloadHash: context.proposal.payloadHash } })
  } },
]
