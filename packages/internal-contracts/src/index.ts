import { z } from 'zod'

export const INTERNAL_LIMITS = { bodyBytes: 131072, timeoutMs: 10000, authorizationSeconds: 300, requestSeconds: 60 } as const
/** Shared task-guidance limits used by both model output validation and Backend transport. */
export const TASK_GUIDANCE_LIMITS = {
  targetChars: 200,
  whereChars: 500,
  bringItemChars: 200,
  stepChars: 500,
  missingItemChars: 200,
  bringItems: 50,
  stepItems: 50,
  missingItems: 50,
  sources: 20,
  citations: 150,
  quoteChars: 200,
} as const
/** Compatibility view for guidance harness code; every transport limit has one source. */
export const GUIDANCE_LIMITS = Object.freeze({
  where: TASK_GUIDANCE_LIMITS.whereChars,
  bringItem: TASK_GUIDANCE_LIMITS.bringItemChars,
  stepItem: TASK_GUIDANCE_LIMITS.stepChars,
  missingItem: TASK_GUIDANCE_LIMITS.missingItemChars,
  items: TASK_GUIDANCE_LIMITS.stepItems,
  sources: TASK_GUIDANCE_LIMITS.sources,
  citations: TASK_GUIDANCE_LIMITS.citations,
  quote: TASK_GUIDANCE_LIMITS.quoteChars,
})
export const internalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
/** ルールのバージョン（例 "1.0.0", "0.0.0-draft"）。internalId と違い "." を許す。 */
export const internalRuleVersion = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/)
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
/** A validated quote that supports one user-visible guidance item. */
export const guidanceCitationSchema = z.object({
  item: z.enum(['where', 'bring', 'steps']), index: z.number().int().min(0).max(TASK_GUIDANCE_LIMITS.stepItems - 1),
  sourceUrl: z.string().url().max(2000), sectionHeading: z.string().min(1).max(200).nullable(),
  quote: z.string().min(1).max(TASK_GUIDANCE_LIMITS.quoteChars),
}).strict()
export type GuidanceCitation = z.infer<typeof guidanceCitationSchema>
const guidanceSchema = resultBase.extend({
  kind: z.literal('task_guidance'), status: z.enum(['COMPLETED', 'PARTIAL', 'FAILED']),
  target: z.string().max(TASK_GUIDANCE_LIMITS.targetChars).nullable().optional(), where: z.string().max(TASK_GUIDANCE_LIMITS.whereChars).nullable().optional(),
  bring: z.array(z.string().max(TASK_GUIDANCE_LIMITS.bringItemChars)).max(TASK_GUIDANCE_LIMITS.bringItems).default([]),
  steps: z.array(z.string().max(TASK_GUIDANCE_LIMITS.stepChars)).max(TASK_GUIDANCE_LIMITS.stepItems).default([]),
  formExampleUrl: z.string().url().max(2000).nullable().optional(), formExampleLabel: z.string().max(120).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  sources: z.array(z.object({ label: z.string().min(1).max(120), url: z.string().url().max(2000), checkedAt: z.string().datetime() }).strict()).max(TASK_GUIDANCE_LIMITS.sources).default([]),
  missing: z.array(z.string().max(TASK_GUIDANCE_LIMITS.missingItemChars)).max(TASK_GUIDANCE_LIMITS.missingItems).default([]), failureReason: z.string().max(500).nullable().optional(),
  citations: z.array(guidanceCitationSchema).max(TASK_GUIDANCE_LIMITS.citations).default([]),
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
const insightTaskSchema = z.object({ id: internalId, version: z.number().int().positive(), title: z.string().min(1).max(120) }).strict()
const insightEventBase = z.object({ id: internalId, caseId: internalId, caseVersion: z.number().int().positive(), expiresAt: z.string().datetime(), task: insightTaskSchema })
/** Issued by an authenticated Backend detector, not by a model or public request. */
export const insightEventSchema = z.discriminatedUnion('kind', [
  insightEventBase.extend({ kind: z.literal('DEADLINE_REVIEW'), deadline: z.object({ id: internalId, version: z.number().int().positive(), dueDate: z.iso.date(), confirmation: z.literal('CONFIRMED'), ruleId: internalId, ruleVersion: internalRuleVersion }).strict() }).strict(),
  insightEventBase.extend({ kind: z.literal('DOCUMENTS_MISSING'), documents: z.array(z.object({ id: internalId, label: z.string().min(1).max(120) }).strict()).min(1).max(20) }).strict(),
  insightEventBase.extend({ kind: z.literal('PROFESSIONAL_REVIEW'), reason: z.string().min(1).max(1000) }).strict(),
  insightEventBase.extend({ kind: z.literal('CASE_CHANGED') }).strict(),
])
export type InsightEvent = z.infer<typeof insightEventSchema>
export const insightDraftSchema = z.object({
  eventId: internalId, resultId: internalId,
  kind: z.enum(['DEADLINE_RISK', 'MISSING_DOCUMENT', 'PROFESSIONAL_NEEDED']), body: z.string().min(1).max(4000),
  relatedTaskId: internalId, relatedTaskTitle: z.string().min(1).max(120),
  evidence: z.array(z.object({ label: z.string().min(1).max(120), value: z.string().min(1).max(2000), taskId: internalId, capturedVersion: z.number().int().positive() }).strict()).min(1).max(20),
  requiresProfessional: z.boolean(), professionalReviewNote: z.string().min(1).max(1000).nullable(),
}).strict()
export type InsightDraft = z.infer<typeof insightDraftSchema>
const completedSchema = resultBase.extend({ kind: z.literal('case_planning'), status: z.enum(['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION']), output: runSummarySchema.optional(), insights: z.array(insightDraftSchema).max(20).optional() }).strict()
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

/** Backend-authenticated control message. It contains no business content or execution capability. */
export const cancelExecutionSchema = z.object({ cancelId: internalId, runId: internalId, jobId: internalId, executionAttempt: internalId,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict()
export type CancelExecution = z.infer<typeof cancelExecutionSchema>
export const cancelExecutionAckSchema = z.object({ cancelId: internalId, runId: internalId, jobId: internalId,
  executionAttempt: internalId, status: z.enum(['STOPPED', 'DUPLICATE']),
}).strict()
