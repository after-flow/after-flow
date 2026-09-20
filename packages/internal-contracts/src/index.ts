import { z } from 'zod'

export const INTERNAL_LIMITS = { bodyBytes: 131072, timeoutMs: 10000, authorizationSeconds: 300, requestSeconds: 60 } as const
export const internalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const operationSchema = z.enum(['case_planning', 'task_guidance', 'chat_reply', 'document_analysis'])
export const scopeSchema = z.enum(['context', 'artifact', 'control', 'heartbeat', 'events', 'result'])
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
const completedSchema = resultBase.extend({ kind: z.literal('case_planning'), status: z.enum(['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION']) }).strict()
export const internalResultSchema = z.discriminatedUnion('kind', [guidanceSchema, chatSchema, completedSchema])
export type InternalResult = z.infer<typeof internalResultSchema>
export const heartbeatSchema = z.object({}).strict()
export const eventSchema = z.object({
  eventId: internalId, sequence: z.number().int().nonnegative(),
  phase: z.enum(['CONTEXT_FETCHED', 'PLANNING', 'GENERATING', 'VALIDATING']),
}).strict()
export type ProgressEvent = z.infer<typeof eventSchema>
const outcomeSchema = z.object({ applied: z.boolean(), reason: z.string().nullable() })
const controlSchema = z.object({ instruction: z.enum(['CONTINUE', 'STOP']), reason: z.string().nullable(), caseVersion: z.number().int().nullable() })

export const internalRoutes = {
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
