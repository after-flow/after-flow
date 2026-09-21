import { z } from 'zod'
import { expectedVersionSchema, idSchema, isoDateSchema, isoDateTimeSchema } from './common.js'

export const flowStageSchema = z.enum([
  'immediate',
  'funeral',
  'government',
  'contracts',
  'investigation',
  'decision',
  'division',
  'transfer',
  'tax',
  'closing',
])

export const taskStatusSchema = z.enum([
  'NOT_STARTED',
  'COLLECTING_INFORMATION',
  'WAITING_DOCUMENTS',
  'READY',
  'SUBMITTED',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
  'COMPLETED',
  'ESCALATED',
])

export const taskCommandSchema = z.enum([
  'start',
  'requestDocuments',
  'markReady',
  'reportSubmission',
  'awaitExternal',
  'complete',
  'reopen',
  'flagActionRequired',
  'escalate',
])

const taskBlockedReasonSchema = z.enum([
  'INVALID_TRANSITION',
  'EVIDENCE_REQUIRED',
  'INHERITANCE_DECISION_REQUIRED',
  'INSUFFICIENT_ROLE',
  'DEPENDENCY_NOT_COMPLETED',
])

export const evidenceKindSchema = z.enum(['RECEIPT', 'NOTICE', 'PAYMENT', 'REGISTRATION', 'OTHER'])

export const deadlineResourceSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  label: z.string(),
  basisLabel: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  daysRemaining: z.number().nullable(),
  severity: z.enum(['NORMAL', 'SOON', 'URGENT', 'OVERDUE']).nullable(),
  confirmation: z.enum(['CONFIRMED', 'UNCONFIRMED']),
  unresolvedReason: z.enum(['MISSING_BASIS_DATE', 'RULE_UNCONFIRMED']).nullable(),
  jurisdiction: z.string(),
  timezone: z.string(),
  ruleId: z.string(),
  ruleVersion: z.string(),
  sourceUrl: z.string().nullable(),
  sourceCheckedAt: isoDateTimeSchema.nullable(),
  extendable: z.boolean().nullable(),
  critical: z.boolean(),
})

export const taskResourceSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: taskStatusSchema,
  stage: flowStageSchema,
  category: z.string(),
  submitTo: z.string().nullable(),
  procedureId: idSchema.nullable(),
  assigneeId: z.string().nullable(),
  dependencyTaskIds: z.array(z.string()),
  escalation: z.object({ proposalId: z.string(), reason: z.string(),
    documents: z.array(z.object({ id: z.string(), version: z.number().int().positive() })),
    contacted: z.literal(false),
  }).nullable(),
  source: z.enum(['MANUAL', 'AI', 'RULE_ENGINE']),
  evidenceRequired: z.boolean(),
  assetDisposal: z.boolean(),
  requiredDocuments: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      documentId: z.string().nullable(),
      source: z.enum(['MANUAL', 'AI', 'RULE_ENGINE']),
    }),
  ),
  completionReportedBy: z.string().nullable(),
  completionReportedAt: isoDateTimeSchema.nullable(),
  deadline: deadlineResourceSchema.nullable(),
  conditional: z.boolean(),
  submitToSource: z.enum(['RULE', 'RESEARCH', 'MANUAL']).nullable(),
  targetDate: deadlineResourceSchema.nullable(),
  evidences: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: evidenceKindSchema,
      note: z.string().nullable(),
      recordedAt: isoDateTimeSchema,
    }),
  ),
  allowedActions: z.array(taskCommandSchema),
  blockedActions: z.array(z.object({ action: taskCommandSchema, reason: taskBlockedReasonSchema })),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const taskIdParamsSchema = z.object({ caseId: idSchema, taskId: idSchema })

const taskReferences = {
  assigneeId: idSchema.nullish(),
  dependencyTaskIds: z.array(idSchema).max(50).optional(),
  requiredDocuments: z.array(z.object({
    id: idSchema, label: z.string().trim().min(1).max(120), documentId: idSchema.nullable(),
  }).strict()).max(50).optional(),
}

export const createTaskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(2000).default(''),
    stage: flowStageSchema,
    category: z.string().trim().min(1).max(50),
    submitTo: z.string().trim().max(120).nullish(),
    evidenceRequired: z.boolean().default(false),
    assetDisposal: z.boolean().default(false),
    /** 手続き定義 ID。存在しない ID は拒否する。 */
    procedureId: idSchema.nullish(),
    ...taskReferences,
  })
  .strict()

/** 説明の訂正。status はここから変更できない。 */
export const updateTaskBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    ...taskReferences,
    title: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().max(2000).optional(),
    submitTo: z.string().trim().max(120).nullish(),
    /** null で解除できる。存在しない ID は拒否する。 */
    procedureId: idSchema.nullish(),
  })
  .strict()

/**
 * 状態を変える唯一の入口。
 * status を直接指定させず、意味のある操作名だけを受け取る。
 */
export const taskCommandBodySchema = z
  .object({
    command: taskCommandSchema,
    expectedVersion: expectedVersionSchema,
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

export const createEvidenceBodySchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    kind: evidenceKindSchema,
    note: z.string().trim().max(500).nullish(),
    documentId: idSchema.nullish(),
  })
  .strict()

export { isoDateSchema }
