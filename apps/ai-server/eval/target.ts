import { z } from 'zod'
import { assertDeliveredDocument, documentScopeSchema, reviewExtraction } from '../src/orchestration/documents/review.js'
import { buildInsurancePreparation, verifyInsurancePreparation } from '../src/orchestration/playbooks/insurance-preparation.js'
import { buildEventInsight } from '../src/orchestration/playbooks/event-insights.js'
import { contentHash } from '../src/orchestration/context/builder.js'
import { guidanceDraftSchema, guidanceResult } from '../src/orchestration/playbooks/guidance-output.js'
import { groundingRulesSchema } from '../src/orchestration/playbooks/guidance-grounding.js'
import { researchEvidenceSchema } from '../src/orchestration/research/contracts.js'
import { sourceDocumentSchema } from '../src/orchestration/research/sources.js'
import { contextProofSchema } from '@aftercare/internal-contracts'
import { fixtureInputSchema } from './dataset.js'

export const observationSchema = z.object({ state: z.string(), error: z.string().optional(), pairs: z.array(z.string()).optional(), externalSubmission: z.boolean().optional() }).strict()
export type Observation = z.infer<typeof observationSchema>
export function executeFixture(raw: unknown): Observation {
  const { family, data } = fixtureInputSchema.parse(raw)
  try {
    if (family === 'document') {
      const document = assertDeliveredDocument(data.document, documentScopeSchema.parse(data.scope))
      const result = reviewExtraction(document, data.extraction)
      return { state: result.conflictingFields.length ? 'CONFLICT' : result.missingFields.length ? 'MISSING' : result.status, pairs: result.candidates.map(candidate => `${candidate.fieldId}=${candidate.value}`).sort() }
    }
    if (family === 'insurance') {
      const preparation = buildInsurancePreparation(data.context, data.procedure)
      const receipt = { artifactId: 'artifact', artifactVersion: 1, contentHash: preparation.contentHash }
      const approval = data.approval === 'none' ? null : { ...receipt, status: data.approval === 'rejected' ? 'REJECTED' : 'APPROVED',
        ...(data.approval === 'wrong-version' ? { artifactVersion: 2 } : {}), ...(data.approval === 'wrong-hash' ? { contentHash: contentHash('wrong') } : {}) }
      return verifyInsurancePreparation(preparation, receipt, approval)
    }
    if (family === 'guidance') {
      const input = z.object({ draft: guidanceDraftSchema, sources: z.array(sourceDocumentSchema), research: researchEvidenceSchema,
        proof: contextProofSchema, target: z.string(), unresolved: z.array(z.string()), rules: groundingRulesSchema }).strict().parse(data)
      const result = guidanceResult({ ...input, resultId: 'fixture-result' })
      if (result.kind !== 'task_guidance') throw new Error('UNEXPECTED_GUIDANCE_RESULT')
      const pairs = [result.where ? `where:${result.where}` : null, ...result.bring.map(item => `bring:${item}`),
        ...result.steps.map(item => `step:${item}`), ...result.missing.map(item => `missing:${item}`)].filter((item): item is string => item !== null).sort()
      return { state: result.status, ...(pairs.length ? { pairs } : {}), ...(result.status === 'FAILED' ? { error: 'CONTRACT' } : {}) }
    }
    const expected = z.object({ caseId: z.string(), caseVersion: z.number(), taskId: z.string(), taskVersion: z.number() }).parse(data.expected)
    return { state: buildEventInsight(data.event, expected).status }
  } catch (error) {
    if (error instanceof z.ZodError) return { state: 'REJECTED', error: 'SCHEMA' }
    const known = new Map([
      ['Document delivery is outside the authorized version or bounds', 'DELIVERY'], ['Extraction lacks exact document evidence', 'EVIDENCE'],
      ['Insurance procedure lacks current reviewed evidence', 'PROCEDURE'], ['Insight event basis is stale or outside scope', 'EVENT'],
    ])
    if (error instanceof Error && known.has(error.message)) return { state: 'REJECTED', error: known.get(error.message)! }
    throw new Error('UNEXPECTED_FIXTURE_FAILURE')
  }
}
