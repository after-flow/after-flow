import { createScorer } from '@mastra/core/evals'
import { expectationSchema, fixtureInputSchema } from './dataset.js'
import { observationSchema } from './target.js'

export const scorerVersion = 'deterministic-contract-v1'
export const contractScorer = createScorer({ id: 'contract-v1', description: 'Required disposition, evidence tuples and prohibited external completion', type: { input: fixtureInputSchema, output: observationSchema } })
  .generateScore(({ run }) => {
    const expected = expectationSchema.safeParse(run.groundTruth); const observed = observationSchema.safeParse(run.output)
    if (!expected.success || !observed.success || observed.data.externalSubmission === true) return 0
    const actual = observed.data; const truth = expected.data
    return actual.state === truth.state && actual.error === truth.error && (truth.pairs === undefined || JSON.stringify([...(actual.pairs ?? [])].sort()) === JSON.stringify([...truth.pairs].sort())) ? 1 : 0
  })
export function extractionMetrics(expected: readonly string[], observed: readonly string[]) {
  const truth = new Set(expected); const actual = new Set(observed); const matched = [...actual].filter(item => truth.has(item)).length
  return { precision: actual.size ? matched / actual.size : truth.size ? 0 : 1, recall: truth.size ? matched / truth.size : actual.size ? 0 : 1 }
}
