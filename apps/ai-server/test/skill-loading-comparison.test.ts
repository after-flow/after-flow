import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareSkillLoadingReports } from '../eval/skill-loading-comparison.js'

function report(skillLoading: 'staged' | 'legacy-all', totalInputTokens: number) {
  return {
    mode: 'live-orcarouter-task-guidance', datasetVersion: 'dataset-v1', skillLoading,
    modelIds: ['openai/model', 'google/model'], caseIds: ['general'], caseCount: 1, repetitions: 2,
    passed: true, completionRate: 1, averageRequiredRecall: 2 / 3, averageCitationCoverage: 1,
    prohibitedClaimRate: 0, totalInputTokens, totalOutputTokens: 100, provisionalSpentUsd: 0.1,
    trials: [1, 2].map(repetition => ({ caseId: 'general', repetition, safe: true })),
  }
}

test('#182 same-condition live reports must preserve the quality gate and reduce measured input tokens', () => {
  const compared = compareSkillLoadingReports(report('legacy-all', 1_000), report('staged', 800))
  assert.equal(compared.qualityGatePreserved, true)
  assert.equal(compared.inputTokensReduced, 200)
  assert.equal(compared.inputTokenReductionRate, 0.2)

  assert.throws(() => compareSkillLoadingReports(report('legacy-all', 1_000), report('staged', 1_000)), /did not reduce/)
  assert.throws(() => compareSkillLoadingReports(report('legacy-all', 1_000), {
    ...report('staged', 800), modelIds: ['different/model'],
  }), /identical models/)
  assert.throws(() => compareSkillLoadingReports(report('legacy-all', 1_000), {
    ...report('staged', 800), prohibitedClaimRate: 0.5,
  }), /quality and safety gate/)
})
