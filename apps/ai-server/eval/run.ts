import { mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Mastra } from '@mastra/core/mastra'
import { DatasetsInMemory, ExperimentsInMemory, InMemoryDB, MastraCompositeStore } from '@mastra/core/storage'
import { dataset, datasetVersion, expectationSchema, fixtureInputSchema } from './dataset.js'
import { executeFixture, observationSchema } from './target.js'
import { contractScorer, extractionMetrics, scorerVersion } from './scorers.js'
import { skillCatalog } from '../src/orchestration/skills/catalog.js'
import { playbooks } from '../src/orchestration/playbooks/registry.js'

const split = process.argv[2] ?? 'development'
if (!['development', 'holdout'].includes(split) || process.argv.length > 3) throw new Error('Usage: eval/run.ts [development|holdout]')
const selected = dataset.filter(item => item.split === split)
const reportPath = resolve('../../reports', `ai-eval-${split}.json`)
const db = new InMemoryDB()
// Ephemeral synthetic evaluation state only; production Workflow persistence remains dedicated Firestore.
const storage = new MastraCompositeStore({ id: 'synthetic-eval', domains: { datasets: new DatasetsInMemory({ db }), experiments: new ExperimentsInMemory({ db }) } })
const mastra = new Mastra({ storage })
const nativeDataset = await mastra.datasets.create({ id: `after-flow-${split}`, name: 'after-flow synthetic harness', inputSchema: fixtureInputSchema, groundTruthSchema: expectationSchema,
  metadata: { version: datasetVersion, split, synthetic: true } })
await nativeDataset.addItems({ items: selected.map(item => ({ id: item.id, input: item.input, groundTruth: item.expected, metadata: { caseId: item.id, severity: item.severity, split } })) })
const report = {
  schemaVersion: 1, mode: 'harness-fixture', realProvider: false, realOrch: false, web: 'fixed-synthetic',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyWorktree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  datasetVersion, scorerVersion, split, caseCount: selected.length, repetitions: 3,
  skills: skillCatalog.map(item => ({ id: item.id, version: item.version, hash: item.hash })),
  playbooks: playbooks.map(item => ({ id: item.id, version: item.version, hash: item.hash })),
  startedAt: new Date().toISOString(), completed: false, passed: false, criticalFailures: 0,
  productCostMicros: null, evaluatorCostMicros: null, model: null, tokens: null,
  trials: [] as { repetition: number; experimentId: string; caseId: string; state: 'PASS' | 'FAIL'; score: number | null; severity: string; elapsedMs: number;
    failure: string | null; output: unknown; expected: unknown; extraction: { precision: number; recall: number } | null }[],
  p50Ms: null as number | null, p95Ms: null as number | null,
}
async function persist() { await mkdir(resolve('../../reports'), { recursive: true }); await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await rename(`${reportPath}.tmp`, reportPath) }
await persist()
try {
  for (let repetition = 1; repetition <= report.repetitions; repetition++) {
    const summary = await nativeDataset.startExperiment({ task: ({ input }) => executeFixture(input), scorers: [contractScorer], maxConcurrency: 1, maxRetries: 0, itemTimeout: 5000,
      signal: AbortSignal.timeout(60000), persistence: { scores: 'none' }, metadata: { repetition, commit: report.commit, datasetVersion, scorerVersion } })
    for (const result of summary.results) {
      const caseId = String(result.metadata?.caseId); const definition = selected.find(item => item.id === caseId)
      if (!definition) throw new Error('Experiment result has unknown case identity')
      const score = result.scores.find(item => item.scorerId === contractScorer.id)?.score ?? null
      const state = result.error || result.persistenceError || score !== 1 ? 'FAIL' as const : 'PASS' as const
      const output = observationSchema.safeParse(result.output)
      report.trials.push({ repetition, experimentId: summary.experimentId, caseId, state, score, severity: definition.severity,
        failure: result.error ? 'TARGET_FAILED' : result.persistenceError ? 'PERSISTENCE_FAILED' : result.scores.some(item => item.error) ? 'SCORER_FAILED' : score !== 1 ? 'EXPECTATION_MISMATCH' : null,
        elapsedMs: result.completedAt.getTime() - result.startedAt.getTime(), output: output.success ? output.data : null, expected: definition.expected,
        extraction: definition.expected.pairs && output.success ? extractionMetrics(definition.expected.pairs, output.data.pairs ?? []) : null })
    }
    const identities = new Set(summary.results.map(item => item.metadata?.caseId))
    await persist()
    if (identities.size !== selected.length || summary.failedCount || summary.skippedCount || summary.persistenceFailures || summary.totalItems !== selected.length) throw new Error('Incomplete experiment')
  }
  const durations = report.trials.map(item => item.elapsedMs).sort((a, b) => a - b)
  const percentile = (fraction: number) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? null
  report.p50Ms = percentile(0.5); report.p95Ms = percentile(0.95)
  report.completed = report.trials.length === selected.length * report.repetitions
  report.criticalFailures = report.trials.filter(item => item.severity === 'critical' && item.state === 'FAIL').length
  report.passed = report.completed && report.trials.every(item => item.state === 'PASS')
} finally { await persist() }
console.log(JSON.stringify({ report: reportPath, cases: report.caseCount, trials: report.trials.length, completed: report.completed, passed: report.passed, criticalFailures: report.criticalFailures, mode: report.mode }))
if (!report.passed) process.exitCode = 1
