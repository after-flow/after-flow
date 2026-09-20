import { readFile } from 'node:fs/promises'
import { z } from 'zod'
const reportSchema = z.object({
  mode: z.literal('harness-fixture'), datasetVersion: z.string(), scorerVersion: z.string(), split: z.enum(['development', 'holdout']),
  repetitions: z.number().int().positive(), caseCount: z.number().int().positive(), completed: z.boolean(), passed: z.boolean(),
  p50Ms: z.number().nonnegative().nullable(), p95Ms: z.number().nonnegative().nullable(),
  trials: z.array(z.object({ caseId: z.string(), repetition: z.number().int().positive(), state: z.enum(['PASS', 'FAIL']), score: z.number().nullable(), elapsedMs: z.number().nonnegative() })),
})
const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath || process.argv.length !== 4) throw new Error('Usage: compare.ts baseline.json candidate.json')
const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async path => reportSchema.parse(JSON.parse(await readFile(path, 'utf8')))))
if (!baseline || !candidate || ['mode', 'datasetVersion', 'scorerVersion', 'split', 'repetitions', 'caseCount'].some(key => baseline[key as keyof typeof baseline] !== candidate[key as keyof typeof candidate])) throw new Error('Evaluation conditions differ')
for (const report of [baseline, candidate]) {
  const keys = new Set(report.trials.map(item => `${item.caseId}/${item.repetition}`))
  if (!report.completed || report.trials.length !== report.caseCount * report.repetitions || keys.size !== report.trials.length) throw new Error('Incomplete or duplicate trials cannot be compared')
}
const rows = baseline.trials.map(before => {
  const after = candidate.trials.find(item => item.caseId === before.caseId && item.repetition === before.repetition)
  if (!after) throw new Error('Missing candidate trial')
  return { caseId: before.caseId, repetition: before.repetition, before: before.state, after: after.state, scoreBefore: before.score, scoreAfter: after.score, elapsedDeltaMs: after.elapsedMs - before.elapsedMs }
})
console.log(JSON.stringify({ mode: candidate.mode, datasetVersion: candidate.datasetVersion, rows,
  p50DeltaMs: baseline.p50Ms !== null && candidate.p50Ms !== null ? candidate.p50Ms - baseline.p50Ms : null,
  p95DeltaMs: baseline.p95Ms !== null && candidate.p95Ms !== null ? candidate.p95Ms - baseline.p95Ms : null,
  note: 'Fixture wall-clock only; real model quality, cost and performance are unevaluated.' }, null, 2))
if (!candidate.passed || rows.some(item => item.after !== 'PASS' || item.scoreAfter !== 1)) process.exitCode = 1
