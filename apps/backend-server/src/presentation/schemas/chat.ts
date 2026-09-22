import { z } from 'zod'
import { idSchema, isoDateTimeSchema } from './common.js'

export const messageResourceSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  role: z.enum(['user', 'assistant']),
  body: z.string(),
  agentRunId: z.string().nullable(),
  replyRunId: z.string().nullable(),
  professionalNotice: z.boolean(),
  escalationProposalId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
})

export const messageAcceptedResourceSchema = z.object({
  message: messageResourceSchema,
  runId: z.string().nullable(),
  runAccepted: z.boolean(),
  reason: z.string().nullable(),
})

export const guidanceResourceSchema = z.object({
  taskId: z.string(),
  status: z.enum(['NOT_REQUESTED', 'RESEARCHING', 'WAITING', 'COMPLETED', 'PARTIAL', 'FAILED']),
  outcome: z.enum(['COMPLETED_RESEARCH', 'MISSING_CONTEXT', 'SOURCE_NOT_CONFIGURED', 'NOT_APPLICABLE', 'FAILED']).nullable(),
  target: z.string().nullable(),
  where: z.string().nullable(),
  bring: z.array(z.string()),
  steps: z.array(z.string()),
  formExampleUrl: z.string().nullable(),
  formExampleLabel: z.string().nullable(),
  note: z.string().nullable(),
  sources: z.array(
    z.object({ label: z.string(), url: z.string(), checkedAt: isoDateTimeSchema }),
  ),
  citations: z.array(
    z.object({
      item: z.enum(['where', 'bring', 'steps']),
      index: z.number().int(),
      sourceUrl: z.string(),
      sectionHeading: z.string().nullable(),
      quote: z.string(),
    }),
  ),
  missing: z.array(z.string()),
  failureReason: z.string().nullable(),
  researchedBy: z.enum(['AI', 'MANUAL']).nullable(),
  agentRunId: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
})

export const postMessageBodySchema = z
  .object({ body: z.string().trim().min(1).max(4000) })
  .strict()

export const taskGuidanceParamsSchema = z.object({ caseId: idSchema, taskId: idSchema })
