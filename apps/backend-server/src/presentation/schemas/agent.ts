import { z } from 'zod'
import { expectedVersionSchema, idSchema, isoDateTimeSchema } from './common.js'

export const agentOperationSchema = z.enum([
  'document_analysis',
  'case_planning',
  'task_guidance',
  'chat_reply',
])

export const agentRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_DOCUMENT',
  'WAITING_APPROVAL',
  'RETRY_SCHEDULED',
  'NEEDS_ATTENTION',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
])

export const agentRunResourceSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  operation: agentOperationSchema,
  status: agentRunStatusSchema,
  targetType: z.enum(['CASE', 'TASK', 'DOCUMENT', 'MESSAGE']),
  targetId: z.string(),
  attempt: z.number().int(),
  waiting: z.boolean(),
  waitingFor: z.string().nullable(),
  failureReason: z.string().nullable(),
  caseVersionAtAccept: z.number().int(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  allowedActions: z.array(z.enum(['cancel', 'retry'])),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const agentRunIdParamsSchema = z.object({ caseId: idSchema, runId: idSchema })

export const acceptAgentRunBodySchema = z
  .object({
    operation: agentOperationSchema,
    targetType: z.enum(['CASE', 'TASK', 'DOCUMENT', 'MESSAGE']),
    targetId: idSchema,
  })
  .strict()

export const agentRunActionBodySchema = z
  .object({ expectedVersion: expectedVersionSchema })
  .strict()
