import { z } from 'zod'
import { idSchema, isoDateTimeSchema, listQuerySchema } from './common.js'
import { createPersonSchema, createRelationshipSchema } from '../routes/public/v1/schemas/persons.js'
import { createAssetSchema, createLiabilitySchema } from '../routes/public/v1/schemas/estate.js'
import { createContractSchema, createBenefitSchema } from '../routes/public/v1/schemas/contracts.js'

export const businessListQuerySchema = listQuerySchema.extend({
  includeExcluded: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
})
const base = { id: idSchema, caseId: idSchema, version: z.number().int().positive() }
export const personResourceSchema = createPersonSchema.extend({
  ...base, role: z.enum(['HEIR_CANDIDATE', 'DECEASED', 'RELATED', 'PROFESSIONAL']), isHeir: z.boolean(),
  excludedAt: isoDateTimeSchema.nullable(),
})
export const relationshipResourceSchema = createRelationshipSchema.extend({ ...base, excludedAt: isoDateTimeSchema.nullable() })
const source = z.enum(['MANUAL', 'AI'])
const confirmation = z.enum(['UNCONFIRMED', 'CONFIRMED'])
const estate = {
  ...base, amount: z.number().int().nonnegative().optional(), currency: z.literal('JPY'), source, confirmation,
  confirmationRecord: z.object({
    state: confirmation, confirmedAt: isoDateTimeSchema.nullable(), confirmedBy: z.string().nullable(),
    confirmedVersion: z.number().int().nullable(),
  }),
}
export const assetResourceSchema = createAssetSchema.extend({ ...estate, taxAttention: z.boolean() })
export const liabilityResourceSchema = createLiabilitySchema.extend(estate)
const progress = z.enum(['NOT_STARTED', 'CONTACTED', 'COMPLETED'])
const progressRecord = z.object({
  reportedAt: isoDateTimeSchema.nullable(), reportedBy: z.string().nullable(),
  source: z.enum(['USER_REPORTED', 'PREPARATION_COMPLETED', 'EXTERNALLY_CONFIRMED']).nullable(), note: z.string().nullable(),
})
export const contractResourceSchema = createContractSchema.extend({
  ...base, source, policy: z.enum(['UNDECIDED', 'CONTINUE', 'TRANSFER', 'CANCEL']), progress, progressRecord,
  policyRecord: z.object({ decidedAt: isoDateTimeSchema.nullable(), decidedBy: z.string().nullable(), note: z.string().nullable() }),
})
export const benefitResourceSchema = createBenefitSchema.extend({
  ...base, amount: z.number().int().nonnegative().optional(), currency: z.literal('JPY'), progress, progressRecord,
})
export const insightResourceSchema = z.object({
  id: idSchema, caseId: idSchema,
  kind: z.enum(['STALLED_TASK', 'DEADLINE_RISK', 'MISSING_DOCUMENT', 'POSSIBLE_CONTRACT', 'POSSIBLE_ASSET', 'INCONSISTENCY', 'PROFESSIONAL_NEEDED']),
  body: z.string(), evidence: z.array(z.object({
    label: z.string(), value: z.string(), documentId: idSchema.optional(), documentName: z.string().optional(),
    taskId: idSchema.optional(), freshness: z.enum(['CURRENT', 'STALE', 'UNAVAILABLE']),
  })),
  detectedAt: isoDateTimeSchema, agentRunId: idSchema, relatedTaskId: idSchema.optional(),
  relatedTaskTitle: z.string().optional(), relatedDocumentId: idSchema.optional(), requiresProfessional: z.boolean(),
  professionalReviewNote: z.string().optional(), status: z.enum(['NEW', 'ACKNOWLEDGED', 'DISMISSED']),
  statusUpdatedAt: isoDateTimeSchema.nullable(),
})
