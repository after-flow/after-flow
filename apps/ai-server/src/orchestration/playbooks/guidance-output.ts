import { z } from 'zod'
import { internalResultSchema, TASK_GUIDANCE_LIMITS } from '@aftercare/internal-contracts'
import type { ContextProof, InternalResult } from '@aftercare/internal-contracts'
import type { SourceDocument } from '../research/sources.js'
import { assertCompleteResearch } from '../research/contracts.js'
import type { ResearchEvidence } from '../research/contracts.js'

const claim = (maxChars: number) => z.object({
  text: z.string().min(1).max(maxChars),
  sourceIds: z.array(z.string().min(1).max(128)).min(1).max(10),
}).strict()
export const guidanceDraftSchema = z.object({
  status: z.enum(['complete', 'partial', 'needs_input']),
  where: claim(TASK_GUIDANCE_LIMITS.whereChars).nullable(),
  bring: z.array(claim(TASK_GUIDANCE_LIMITS.bringItemChars)).max(TASK_GUIDANCE_LIMITS.bringItems),
  steps: z.array(claim(TASK_GUIDANCE_LIMITS.stepChars)).max(TASK_GUIDANCE_LIMITS.stepItems),
  missing: z.array(z.string().min(1).max(TASK_GUIDANCE_LIMITS.missingItemChars)).max(TASK_GUIDANCE_LIMITS.missingItems),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'complete' && (!value.where || !value.bring.length || !value.steps.length || value.missing.length)) {
    ctx.addIssue({ code: 'custom', message: 'Complete guidance requires location, documents, steps and no missing information' })
  }
  if (value.status !== 'complete' && !value.missing.length) ctx.addIssue({ code: 'custom', message: 'Partial guidance must state missing information' })
})
export type GuidanceDraft = z.infer<typeof guidanceDraftSchema>

export class GuidanceOutputContractError extends Error {
  readonly code = 'OUTPUT_CONTRACT_REJECTED'
  constructor() {
    super('Core Agent output did not satisfy the task guidance contract')
    this.name = 'GuidanceOutputContractError'
  }
}

/** General guidance cannot assert that it applies to this Case without these confirmations. */
export function requireCaseApplicability(draftInput: GuidanceDraft, requiredQuestions: readonly string[]): GuidanceDraft {
  const draft = guidanceDraftSchema.parse(draftInput)
  if (!requiredQuestions.length) return draft
  const missing = [...new Set([...draft.missing, ...requiredQuestions])]
  return guidanceDraftSchema.parse({ ...draft, status: draft.status === 'needs_input' ? 'needs_input' : 'partial', missing })
}

export function guidanceResult(input: { draft: GuidanceDraft; sources: readonly SourceDocument[]; research: ResearchEvidence; proof: ContextProof; resultId: string; target: string }): InternalResult {
  const draft = guidanceDraftSchema.parse(input.draft)
  const available = new Map(input.sources.map(source => [source.id, source]))
  if (draft.status === 'complete') assertCompleteResearch(input.research, new Set(available.keys()))
  const used = new Set<string>()
  for (const item of [...(draft.where ? [draft.where] : []), ...draft.bring, ...draft.steps]) {
    for (const id of item.sourceIds) {
      if (!available.has(id)) throw new Error('Guidance cites a source which was not retrieved')
      used.add(id)
    }
  }
  // Backend stores its current public guidance DTO; claim-to-source mapping stays in the workflow snapshot.
  return internalResultSchema.parse({
    ...input.proof, resultId: input.resultId, kind: 'task_guidance',
    status: draft.status === 'complete' ? 'COMPLETED' : 'PARTIAL', target: input.target,
    where: draft.where?.text ?? null, bring: draft.bring.map(item => item.text), steps: draft.steps.map(item => item.text),
    missing: draft.missing, sources: [...used].map(id => {
      const source = available.get(id)!
      return { label: source.title, url: source.url, checkedAt: source.fetchedAt }
    }), basis: [],
  })
}
