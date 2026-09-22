import { z } from 'zod'
import { expectedVersionSchema, idSchema, isoDateTimeSchema } from './common.js'

export const proposalKindSchema = z.enum([
  'TASK_PROPOSAL',
  'ASSET_PROPOSAL',
  'LIABILITY_PROPOSAL',
  'CONTRACT_PROPOSAL',
  'PERSON_PROPOSAL',
  'DOCUMENT_REQUEST',
  'ESCALATION_PROPOSAL',
  'EVIDENCE_PROPOSAL',
])

const proposalBasisSchema = z.object({
  type: z.enum(['DOCUMENT', 'TASK', 'MESSAGE']),
  id: idSchema,
  version: z.number().int().min(1),
  label: z.string().max(120),
})

export const proposalResourceSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  kind: proposalKindSchema,
  status: z.enum(['SUBMITTED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPLIED', 'REJECTED', 'STALE', 'EXPIRED']),
  source: z.enum(['USER', 'SYSTEM', 'AI']),
  agentRunId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  proposalVersion: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string(),
  basis: z.array(proposalBasisSchema),
  caseVersionAtProposal: z.number().int(),
  assetDisposal: z.boolean(),
  supersedesProposalVersion: z.number().int().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const approvalResourceSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  proposalId: z.string(),
  proposalVersion: z.number().int(),
  payloadHash: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']),
  applicationStatus: z.enum(['NOT_APPLIED', 'APPLIED', 'FAILED']),
  applicationFailureReason: z.string().nullable(),
  decidedByUserId: z.string().nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decisionNote: z.string().nullable(),
  expiresAt: isoDateTimeSchema,
  assetDisposal: z.boolean(),
  sourceDocumentId: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const inheritanceMethodSchema = z.enum([
  'SIMPLE_ACCEPTANCE',
  'LIMITED_ACCEPTANCE',
  'RENUNCIATION',
])

export const inheritanceDecisionResourceSchema = z.object({
  personId: z.string(),
  method: inheritanceMethodSchema.nullable(),
  state: z.enum(['DRAFT', 'REPORTED', 'CONFIRMED']),
  confirmed: z.boolean(),
  reportedByUserId: z.string().nullable(),
  confirmedByUserId: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: isoDateTimeSchema,
})

export const proposalIdParamsSchema = z.object({ caseId: idSchema, proposalId: idSchema })
export const proposalVersionParamsSchema = proposalIdParamsSchema.extend({ proposalVersion: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
export const proposalVersionResourceSchema = proposalResourceSchema.omit({
  id: true, status: true, version: true, createdAt: true, updatedAt: true,
}).extend({ proposalId: idSchema, recordedAt: isoDateTimeSchema })
export const approvalIdParamsSchema = z.object({ caseId: idSchema, approvalId: idSchema })
export const personIdParamsSchema = z.object({ caseId: idSchema, personId: idSchema })

export const submitProposalBodySchema = z
  .object({
    kind: proposalKindSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(2000).default(''),
    payload: z.record(z.string(), z.unknown()),
    basis: z.array(proposalBasisSchema).max(20).default([]),
    assetDisposal: z.boolean().default(false),
  })
  .strict()

/** 訂正。既存の版は書き換えず、新しい版を作る。 */
export const reviseProposalBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export const requestApprovalBodySchema = z
  .object({ expectedVersion: expectedVersionSchema })
  .strict()

/**
 * 承認。
 * 見た内容の版とhashを指定させ、承認後に対象が変わっていないことを確かめる。
 */
export const approveBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    proposalVersion: z.number().int().min(1),
    payloadHash: z.string().min(1).max(200),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

export const rejectBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

export const recordDecisionBodySchema = z
  .object({
    method: inheritanceMethodSchema.nullable(),
    state: z.enum(['DRAFT', 'REPORTED']),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

export const confirmDecisionBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    method: inheritanceMethodSchema,
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
