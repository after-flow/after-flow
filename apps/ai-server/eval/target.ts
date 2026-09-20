import { z } from 'zod'
import { assertDeliveredDocument, documentScopeSchema, reviewExtraction } from '../src/orchestration/documents/review.js'
import { buildInsurancePreparation, verifyInsurancePreparation } from '../src/orchestration/playbooks/insurance-preparation.js'
import { buildEventInsight } from '../src/orchestration/playbooks/event-insights.js'
import { contentHash } from '../src/orchestration/context/builder.js'
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
