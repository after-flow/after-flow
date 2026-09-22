import { z } from 'zod'
import { idSchema, isoDateTimeSchema, expectedVersionSchema, listQuerySchema } from './common.js'
import { proposalResourceSchema, approvalResourceSchema } from './proposal.js'
import { agentRunResourceSchema } from './agent.js'

export const documentKindSchema = z.enum([
  'DEATH_CERTIFICATE',
  'FAMILY_REGISTER',
  'WILL',
  'CONTRACT',
  'BANK_STATEMENT',
  'INSURANCE_POLICY',
  'OTHER',
])

const findingSchema = z.object({
  kind: z.enum(['SENSITIVE_NUMBER', 'UNSUPPORTED_CONTENT', 'UNREADABLE']),
  message: z.string(),
  locationHint: z.string().nullable(),
})

export const documentResourceSchema = z.object({
  extractionCandidates: z.array(proposalResourceSchema.pick({ id: true, proposalVersion: true, kind: true, title: true, payload: true, status: true, basis: true })),
  proposalRefs: z.array(proposalResourceSchema.pick({ id: true, proposalVersion: true, kind: true, status: true, source: true })),
  approvalRefs: z.array(approvalResourceSchema.pick({ id: true, proposalId: true, proposalVersion: true, status: true, applicationStatus: true })),
  evidenceRefs: z.array(z.object({ id: z.string(), taskId: z.string(), label: z.string(), version: z.number().int() })),
  id: z.string(),
  caseId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  kind: documentKindSchema,
  kindSource: z.enum(['MANUAL', 'AI']),
  storageState: z.enum(['UPLOADING', 'STORED', 'FAILED']),
  inspection: z.object({
    status: z.enum(['PENDING', 'IN_PROGRESS', 'PASSED', 'REJECTED', 'FAILED']),
    completed: z.boolean(),
    findings: z.array(findingSchema),
  }),
  analysis: z.object({
    run: agentRunResourceSchema.pick({ id: true, status: true, waiting: true, waitingFor: true, failureReason: true, version: true }).nullable(),
    state: z.enum(['NOT_REQUESTED', 'NOT_CONNECTED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
    agentRunId: z.string().nullable(),
    canRequest: z.boolean(),
    blockedReasons: z.array(z.enum(['INSPECTION_NOT_PASSED', 'AI_NOT_CONNECTED', 'CONSENT_REQUIRED', 'ALREADY_IN_PROGRESS', 'KIND_NOT_SUPPORTED'])),
  }),
  archived: z.boolean(),
  archivedAt: isoDateTimeSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const documentIdParamsSchema = z.object({ caseId: idSchema, documentId: idSchema })

export const documentListQuerySchema = listQuerySchema.extend({
  /**
   * 除外済みも含めるか。
   * 既定では通常の一覧から外す。完全消去とは別の扱いであることを
   * 呼び出し側が選べるようにする。
   */
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

export const archiveDocumentBodySchema = z
  .object({ expectedVersion: expectedVersionSchema })
  .strict()
