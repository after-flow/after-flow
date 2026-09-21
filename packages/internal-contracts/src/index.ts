import { z } from 'zod'

export const INTERNAL_LIMITS = { bodyBytes: 131072, timeoutMs: 10000, authorizationSeconds: 300, requestSeconds: 60 } as const
export const internalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const operationSchema = z.enum(['case_planning', 'task_guidance', 'chat_reply', 'document_analysis'])
export const scopeSchema = z.enum(['context', 'artifact', 'control', 'heartbeat', 'events', 'result', 'proposals', 'wait-requests'])
export type InternalScope = z.infer<typeof scopeSchema>

/** Backend が発行するcapability。AIへ署名鍵は渡さない。 */
export const executionClaimsSchema = z.object({
  tenantId: internalId, caseId: internalId, runId: internalId, jobId: internalId,
  executionAttempt: internalId, operation: operationSchema,
  scopes: z.array(scopeSchema).min(1),
})
export type ExecutionClaims = z.infer<typeof executionClaimsSchema>

/** GETにも同じmetadataをheaderで要求する。bodyの自己申告scopeは受け取らない。 */
export const requestMetadataSchema = z.object({
  requestId: internalId, jobId: internalId, executionAttempt: internalId,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
})
export type InternalRequestMetadata = z.infer<typeof requestMetadataSchema>

export const contextProofSchema = z.object({
  caseVersion: z.number().int().positive(), contextSnapshotId: internalId,
  fencingToken: z.number().int().positive(),
  artifactVersion: z.number().int().positive(), contentHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
export type ContextProof = z.infer<typeof contextProofSchema>
export const artifactEnvelopeSchema = contextProofSchema.extend({
  expiresAt: z.string().datetime(), content: z.record(z.string(), z.unknown()),
})
export type ContextArtifact = z.infer<typeof artifactEnvelopeSchema>

const basisSchema = z.object({ type: z.enum(['DOCUMENT', 'TASK', 'MESSAGE']), id: internalId, version: z.number().int().positive() }).strict()
const resultBase = contextProofSchema.extend({ resultId: internalId, basis: z.array(basisSchema).max(20).default([]) })
const guidanceSchema = resultBase.extend({
  kind: z.literal('task_guidance'), status: z.enum(['COMPLETED', 'PARTIAL', 'FAILED']),
  target: z.string().max(200).nullable().optional(), where: z.string().max(500).nullable().optional(),
  bring: z.array(z.string().max(200)).max(50).default([]), steps: z.array(z.string().max(500)).max(50).default([]),
  formExampleUrl: z.string().url().max(2000).nullable().optional(), formExampleLabel: z.string().max(120).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  sources: z.array(z.object({ label: z.string().min(1).max(120), url: z.string().url().max(2000), checkedAt: z.string().datetime() }).strict()).max(20).default([]),
  missing: z.array(z.string().max(200)).max(50).default([]), failureReason: z.string().max(500).nullable().optional(),
}).strict()
const chatSchema = resultBase.extend({ kind: z.literal('chat_reply'), body: z.string().min(1).max(10000), professionalNotice: z.boolean().default(false) }).strict()
export const runSummarySchema = z.object({
  summary: z.string().max(1000), completed: z.array(z.string().min(1).max(300)).max(20),
  questions: z.array(z.string().min(1).max(300)).max(20), remaining: z.array(z.string().min(1).max(300)).max(20),
}).strict()
export type RunSummary = z.infer<typeof runSummarySchema>
export const clarificationHistorySchema = z.array(z.object({
  resultId: internalId, questionIndex: z.number().int().min(0).max(19), question: z.string().min(1).max(300),
  answer: z.string().min(1).max(1000), caseVersion: z.number().int().positive(), state: z.literal('user_reported'),
}).strict()).max(60)
export type ClarificationHistory = z.infer<typeof clarificationHistorySchema>
const completedSchema = resultBase.extend({ kind: z.literal('case_planning'), status: z.enum(['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION']), output: runSummarySchema.optional() }).strict()
export const interruptedResultSchema = resultBase.extend({ kind: z.literal('execution_interrupted'), operation: operationSchema,
  status: z.literal('NEEDS_ATTENTION'), failureReason: z.enum(['BUDGET_EXCEEDED', 'TIME_LIMIT', 'EXECUTION_FAILED']), output: runSummarySchema,
}).strict()
export const internalResultSchema = z.discriminatedUnion('kind', [guidanceSchema, chatSchema, completedSchema, interruptedResultSchema])
export type InternalResult = z.infer<typeof internalResultSchema>
export const heartbeatSchema = z.object({}).strict()
const progressEventSchema = z.object({
  eventId: internalId, sequence: z.number().int().nonnegative(),
  phase: z.enum(['CONTEXT_FETCHED', 'PLANNING', 'GENERATING', 'VALIDATING']),
}).strict()
const waitingEventSchema = z.object({ eventId: internalId, type: z.literal('WAITING'), waitRequestId: internalId, snapshotId: internalId }).strict()
export const eventSchema = z.union([progressEventSchema, waitingEventSchema])
export type ProgressEvent = z.infer<typeof eventSchema>
export const waitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('APPROVAL'), approvalId: internalId }).strict(),
  z.object({ kind: z.literal('DOCUMENTS'), taskId: internalId, requiredDocumentIds: z.array(internalId).min(1).max(20) }).strict(),
])
export type WaitCondition = z.infer<typeof waitConditionSchema>
export const waitRequestSchema = contextProofSchema.extend({ waitRequestId: internalId, condition: waitConditionSchema }).strict()
export type WaitRequestInput = z.infer<typeof waitRequestSchema>
export const snapshotStatusSchema = z.object({
  runId: internalId, jobId: internalId, executionAttempt: internalId, waitRequestId: internalId.nullable(),
  state: z.enum(['MISSING', 'WAITING', 'RUNNING_CHECKPOINT', 'COMPLETED']), snapshotId: internalId.nullable(),
}).strict().refine(value => !['WAITING', 'RUNNING_CHECKPOINT'].includes(value.state) || value.snapshotId !== null,
  { message: 'Durable state requires snapshotId' })
export type ExecutionSnapshotStatus = z.infer<typeof snapshotStatusSchema>
export const aiProposalSchema = contextProofSchema.extend({
  proposalId: internalId,
  kind: z.enum(['TASK_PROPOSAL', 'ASSET_PROPOSAL', 'LIABILITY_PROPOSAL', 'CONTRACT_PROPOSAL', 'PERSON_PROPOSAL', 'DOCUMENT_REQUEST', 'ESCALATION_PROPOSAL', 'EVIDENCE_PROPOSAL']),
  title: z.string().min(1).max(120), summary: z.string().max(2000).default(''),
  payload: z.record(z.string(), z.unknown()),
  basis: z.array(basisSchema.extend({ label: z.string().max(120) })).max(20).default([]),
  assetDisposal: z.boolean().default(false),
}).strict()
export type AiProposalInput = z.infer<typeof aiProposalSchema>
const outcomeSchema = z.object({ applied: z.boolean(), reason: z.string().nullable() })
const controlSchema = z.object({ instruction: z.enum(['CONTINUE', 'STOP']), reason: z.string().nullable(), caseVersion: z.number().int().nullable() })

export const internalRoutes = {
  'wait-requests': { method: 'post', path: '/runs/:runId/wait-requests', scope: 'wait-requests', body: waitRequestSchema,
    response: z.object({ waitRequestId: internalId, state: z.literal('PENDING_SNAPSHOT') }) },
  proposals: { method: 'post', path: '/runs/:runId/proposals', scope: 'proposals', body: aiProposalSchema,
    response: z.object({ proposalId: internalId, approvalId: internalId, proposalVersion: z.number().int().positive(), payloadHash: z.string(),
      waitRequestId: internalId.nullable(), applicationStatus: z.enum(['NOT_APPLIED', 'APPLIED']) }) },
  context: { method: 'get', path: '/runs/:runId/context', scope: 'context', response: artifactEnvelopeSchema },
  artifact: { method: 'get', path: '/runs/:runId/artifacts/:artifactId', scope: 'artifact', response: artifactEnvelopeSchema },
  control: { method: 'get', path: '/runs/:runId/control', scope: 'control', response: controlSchema },
  heartbeat: { method: 'post', path: '/runs/:runId/heartbeat', scope: 'heartbeat', body: heartbeatSchema,
    response: z.object({ accepted: z.literal(true), executionAuthorization: z.string() }) },
  events: { method: 'post', path: '/runs/:runId/events', scope: 'events', body: eventSchema, response: outcomeSchema },
  result: { method: 'post', path: '/runs/:runId/result', scope: 'result', body: internalResultSchema, response: outcomeSchema },
} as const

/** 個人情報や任意promptを送らない。配送attemptと実行attemptを混同しない。 */
export const dispatchSchema = z.object({
  jobId: internalId, runId: internalId, executionAttempt: internalId, operation: operationSchema,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), executionAuthorization: z.string().min(1).max(4096),
}).strict()
export type RunDispatch = z.infer<typeof dispatchSchema>
export const dispatchAckSchema = z.object({ jobId: internalId, runId: internalId, status: z.enum(['ACCEPTED', 'DUPLICATE']) }).strict()

/** Formal Proposal status for a Run; approval itself must never be inferred from an AI message. */
export const proposalActionStateSchema = z.object({
  id: internalId, actionId: internalId.nullable(), proposalVersion: z.number().int().positive(),
  payloadHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  status: z.enum(['SUBMITTED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPLIED', 'REJECTED', 'STALE', 'EXPIRED']),
}).strict()

const proposalHistoryItemSchema = proposalActionStateSchema.extend({
  kind: aiProposalSchema.shape.kind, source: z.enum(['USER', 'SYSTEM', 'AI']),
  title: z.string().max(120), summary: z.string().max(2000),
  targetTitle: z.string().max(500).nullable(), targetTaskId: internalId.nullable(),
  assetDisposal: z.boolean(), supersedesProposalVersion: z.number().int().positive().nullable(),
}).strict()
export const planningHistorySchema = z.object({
  complete: z.literal(true),
  proposals: z.array(proposalHistoryItemSchema).max(100),
  versions: z.array(z.object({
    proposalId: internalId, proposalVersion: z.number().int().positive(), payloadHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    title: z.string().max(120), summary: z.string().max(2000), targetTitle: z.string().max(500).nullable(),
    supersedesProposalVersion: z.number().int().positive().nullable(),
  }).strict()).max(100),
  approvals: z.array(z.object({
    proposalId: internalId, proposalVersion: z.number().int().positive(), payloadHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']), applicationStatus: z.enum(['NOT_APPLIED', 'APPLIED', 'FAILED']),
    decisionNote: z.string().max(2000).nullable(), applicationFailureReason: z.string().max(2000).nullable(),
  }).strict()).max(100),
}).strict().superRefine((history, ctx) => {
  const versions = new Map(history.versions.map(item => [`${item.proposalId}:${item.proposalVersion}`, item]))
  if (versions.size !== history.versions.length || new Set(history.proposals.map(item => item.id)).size !== history.proposals.length) {
    ctx.addIssue({ code: 'custom', message: 'Planning history identity collision' })
  }
  for (const proposal of history.proposals) {
    if (proposal.proposalVersion > 100) { ctx.addIssue({ code: 'custom', message: 'Planning history is incomplete' }); continue }
    for (let version = 1; version <= proposal.proposalVersion; version++) {
      const stored = versions.get(`${proposal.id}:${version}`)
      if (!stored || (version === proposal.proposalVersion && stored.payloadHash !== proposal.payloadHash)) ctx.addIssue({ code: 'custom', message: 'Planning history is incomplete' })
    }
  }
  for (const approval of history.approvals) {
    if (versions.get(`${approval.proposalId}:${approval.proposalVersion}`)?.payloadHash !== approval.payloadHash) ctx.addIssue({ code: 'custom', message: 'Approval history does not match its version' })
  }
})
export type PlanningHistory = z.infer<typeof planningHistorySchema>


/** Backend-owned case planning pause. null is explicit absence; omission is not permission. */
export const planningRestrictionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().nullable()
export type PlanningRestriction = z.infer<typeof planningRestrictionSchema>
