import { z } from 'zod'
import { agentRunResourceSchema } from './agent.js'
import { caseResourceSchema } from './case.js'
import { isoDateTimeSchema } from './common.js'
import { inheritanceMethodSchema } from './proposal.js'
import { deadlineResourceSchema, flowStageSchema, taskStatusSchema } from './task.js'

const flowStageResourceSchema = z.object({
  id: flowStageSchema,
  label: z.string(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  state: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'NO_TASKS']),
})

const decisionSummarySchema = z.object({
  personId: z.string(),
  personName: z.string().nullable(),
  method: inheritanceMethodSchema.nullable(),
  state: z.enum(['DRAFT', 'REPORTED', 'CONFIRMED']),
  confirmed: z.boolean(),
})

export const caseOverviewResourceSchema = z.object({
  case: caseResourceSchema,
  aggregatedAt: isoDateTimeSchema,
  consistency: z.literal('SNAPSHOT'),
  caseVersion: z.number().int(),
  // 状態ごとの件数。0 件の状態は省く。すべての状態を必ず含めない。
  taskCounts: z.partialRecord(taskStatusSchema, z.number().int()),
  totalTasks: z.number().int(),
  flowStages: z.array(flowStageResourceSchema),
  upcomingDeadlines: z.array(deadlineResourceSchema),
  unresolvedDeadlineCount: z.number().int(),
  pendingApprovalCount: z.number().int(),
  appliedApprovalCount: z.number().int(),
  inheritanceDecision: z.object({
    decided: z.boolean(),
    unknown: z.boolean(),
    perHeir: z.array(decisionSummarySchema),
  }),
  recentAgentRuns: z.array(agentRunResourceSchema),
  aiConnected: z.boolean(),
})
