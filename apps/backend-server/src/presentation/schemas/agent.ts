import { z } from 'zod'
import { runSummarySchema } from '@aftercare/internal-contracts'
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
  outcome: runSummarySchema.extend({ resultId: idSchema, attemptId: idSchema, caseVersion: z.number().int().positive() }).nullable(),
  caseVersionAtAccept: z.number().int(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  allowedActions: z.array(z.enum(['cancel', 'retry'])),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const agentRunIdParamsSchema = z.object({ caseId: idSchema, runId: idSchema })

export const agentRunEventKindSchema = z.enum([
  'ACCEPTED',
  'PROGRESS',
  'WAITING',
  'RESUMED',
  'RESULT',
  'CANCELLED',
  'RETRIED',
])

/**
 * 公開可能なAgentRun進捗イベント（Issue #125）。
 *
 * `detail` は列挙値やIDなど安全な範囲の付随情報のみを返す契約。
 * prompt、非公開の思考、資格情報、原本文はサーバー側で決して詰めない。
 */
export const agentRunEventResourceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  eventId: z.string(),
  kind: agentRunEventKindSchema,
  status: agentRunStatusSchema,
  attempt: z.number().int(),
  sequence: z.number().int().positive(),
  detail: z.record(z.string(), z.unknown()),
  occurredAt: isoDateTimeSchema,
})

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


export const answerPlanningQuestionsSchema = z.object({
  expectedVersion: expectedVersionSchema, resultId: idSchema,
  answers: z.array(z.object({ questionIndex: z.number().int().min(0).max(19), answer: z.string().trim().min(1).max(1000) }).strict()).min(1).max(20),
}).strict().refine(value => new Set(value.answers.map(answer => answer.questionIndex)).size === value.answers.length, 'Duplicate answer index')
