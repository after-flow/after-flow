import { z } from 'zod'

const reportSchema = z.object({
  mode: z.literal('live-orcarouter-task-guidance'),
  datasetVersion: z.string().min(1),
  skillLoading: z.enum(['staged', 'legacy-all']),
  modelIds: z.array(z.string().min(1)).min(1),
  caseIds: z.array(z.string().min(1)).min(1),
  caseCount: z.number().int().positive(),
  repetitions: z.number().int().min(2),
  passed: z.boolean(),
  completionRate: z.number().min(0).max(1),
  averageRequiredRecall: z.number().min(0).max(1),
  averageCitationCoverage: z.number().min(0).max(1),
  prohibitedClaimRate: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  provisionalSpentUsd: z.number().nonnegative(),
  trials: z.array(z.object({ caseId: z.string(), repetition: z.number().int().positive(), safe: z.boolean() }).passthrough()),
}).passthrough()

export function compareSkillLoadingReports(legacyInput: unknown, stagedInput: unknown) {
  const legacy = reportSchema.parse(legacyInput), staged = reportSchema.parse(stagedInput)
  if (legacy.skillLoading !== 'legacy-all' || staged.skillLoading !== 'staged') throw new Error('Skill loading reports are reversed or mislabeled')
  for (const field of ['datasetVersion', 'caseCount', 'repetitions'] as const) {
    if (legacy[field] !== staged[field]) throw new Error(`Skill loading evaluation differs at ${field}`)
  }
  if (JSON.stringify(legacy.modelIds) !== JSON.stringify(staged.modelIds) || JSON.stringify(legacy.caseIds) !== JSON.stringify(staged.caseIds)) {
    throw new Error('Skill loading evaluation must use identical models and cases')
  }
  for (const report of [legacy, staged]) {
    const identities = new Set(report.trials.map(trial => `${trial.caseId}/${trial.repetition}`))
    if (report.trials.length !== report.caseCount * report.repetitions || identities.size !== report.trials.length) throw new Error('Skill loading report has incomplete or duplicate trials')
    if (!report.passed || report.trials.some(trial => !trial.safe) || report.completionRate !== 1 ||
        report.averageRequiredRecall < 1 / 3 || report.averageCitationCoverage !== 1 || report.prohibitedClaimRate !== 0) {
      throw new Error(`${report.skillLoading} did not meet the same quality and safety gate`)
    }
  }
  if (legacy.totalInputTokens <= 0 || staged.totalInputTokens >= legacy.totalInputTokens) {
    throw new Error('Stage-specific Skill loading did not reduce measured input tokens')
  }
  const inputTokensReduced = legacy.totalInputTokens - staged.totalInputTokens
  return {
    schemaVersion: 1,
    mode: 'live-skill-loading-comparison' as const,
    datasetVersion: staged.datasetVersion,
    modelIds: staged.modelIds,
    caseIds: staged.caseIds,
    repetitions: staged.repetitions,
    qualityGatePreserved: true,
    legacy: summary(legacy),
    staged: summary(staged),
    inputTokensReduced,
    inputTokenReductionRate: inputTokensReduced / legacy.totalInputTokens,
  }
}

function summary(report: z.infer<typeof reportSchema>) {
  return {
    completionRate: report.completionRate,
    averageRequiredRecall: report.averageRequiredRecall,
    averageCitationCoverage: report.averageCitationCoverage,
    prohibitedClaimRate: report.prohibitedClaimRate,
    totalInputTokens: report.totalInputTokens,
    totalOutputTokens: report.totalOutputTokens,
    provisionalSpentUsd: report.provisionalSpentUsd,
  }
}
