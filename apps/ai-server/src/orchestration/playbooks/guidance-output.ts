import { z } from 'zod'
import { internalResultSchema } from '@aftercare/internal-contracts'
import type { ContextProof, InternalResult } from '@aftercare/internal-contracts'
import type { SourceDocument } from '../research/sources.js'
import { assertCompleteResearch } from '../research/contracts.js'
import type { ResearchEvidence } from '../research/contracts.js'

const claim = z.object({ text: z.string().min(1).max(500), sourceIds: z.array(z.string().min(1).max(128)).min(1).max(10) }).strict()
export const guidanceDraftSchema = z.object({
  status: z.enum(['complete', 'partial', 'needs_input']),
  where: claim.nullable(), bring: z.array(claim).max(50), steps: z.array(claim).max(50),
  missing: z.array(z.string().min(1).max(200)).max(50),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'complete' && (!value.where || !value.bring.length || !value.steps.length || value.missing.length)) {
    ctx.addIssue({ code: 'custom', message: 'Complete guidance requires location, documents, steps and no missing information' })
  }
  if (value.status !== 'complete' && !value.missing.length) ctx.addIssue({ code: 'custom', message: 'Partial guidance must state missing information' })
})
export type GuidanceDraft = z.infer<typeof guidanceDraftSchema>

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
  const form = officialForm(input.sources.filter(source => used.has(source.id)))
  // Backend stores its current public guidance DTO; claim-to-source mapping stays in the workflow snapshot.
  return internalResultSchema.parse({
    ...(form ? { formExampleUrl: form.url, formExampleLabel: form.label } : {}),
    ...input.proof, resultId: input.resultId, kind: 'task_guidance',
    status: draft.status === 'complete' ? 'COMPLETED' : 'PARTIAL', target: input.target,
    where: draft.where?.text ?? null, bring: draft.bring.map(item => item.text), steps: draft.steps.map(item => item.text),
    missing: draft.missing, sources: [...used].map(id => {
      const source = available.get(id)!
      return { label: source.title, url: source.url, checkedAt: source.fetchedAt }
    }), basis: [],
  })
}

/**
 * 引用した公式資料に掲載された申請書（無ければ記入例）へのリンク（#165）。
 * ハーネスが本文から決定的に抽出した値だけを使い、モデルにURLを書かせない。
 */
export function officialForm(sources: readonly SourceDocument[]) {
  const forms = sources.flatMap(source => source.forms)
  return forms.find(form => form.kind === 'FORM') ?? forms.find(form => form.kind === 'EXAMPLE') ?? null
}
