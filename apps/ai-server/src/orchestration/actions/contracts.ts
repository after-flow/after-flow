import { z } from 'zod'
import { aiProposalSchema, internalId } from '@aftercare/internal-contracts'
import { contentHash } from '../context/builder.js'

export const proposalDraftSchema = aiProposalSchema.omit({ proposalId: true, caseVersion: true, contextSnapshotId: true, fencingToken: true, artifactVersion: true, contentHash: true })
export type ProposalDraft = z.infer<typeof proposalDraftSchema>
export const actionReceiptSchema = z.object({
  actionId: internalId, proposalId: internalId, approvalId: internalId, proposalVersion: z.number().int().positive(),
  payloadHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), waitRequestId: internalId.nullable(), applicationStatus: z.enum(['NOT_APPLIED', 'APPLIED']),
}).strict()
export type ActionReceipt = z.infer<typeof actionReceiptSchema>

/** Logical slot is selected by the harness; retries/attempt IDs never enter this identity. */
export function actionIdFor(runId: string, playbookVersion: string, logicalSlot: string): string {
  internalId.parse(runId); internalId.parse(playbookVersion); internalId.parse(logicalSlot)
  return contentHash({ runId, playbookVersion, logicalSlot })
}
