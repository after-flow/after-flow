import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createOrcaModel } from '../../src/infrastructure/orcarouter/models.js'
import { readOrcaApiKey } from '../../src/infrastructure/orcarouter/environment.js'
import { skillCatalog } from '../../src/orchestration/skills/catalog.js'
import { contentHash } from '../../src/orchestration/context/builder.js'
import { sourceRevision } from '../git.js'
import { GUIDANCE_CASES } from './cases.js'
import type { GuidanceCase } from './cases.js'
import { finalCostUsd } from './meter.js'
import type { CallRecord } from './meter.js'
import { REQUIRED_FACTS, scoreGuidance } from './scoring.js'
import type { FactId, ProhibitedId, TrialScore } from './scoring.js'
import { runTrial } from './target.js'
import type { TrialTarget } from './target.js'

/**
 * task_guidanceの評価（#164）。
 *
 *   fixture: 再生したモデル出力で、ハーネス（検証・分割・引用付与）を決定的に評価する。APIキー不要でCI向け。
 *   live:    実OrcaRouterのモデルで同じケースを複数回実行し、品質・揺れ・時間・費用を測る。
 *            `--max-usd` が必須で、次の試行が上限を超える見込みなら実行しない。
 *
 * レポートには案内の本文を書かない。失敗は分類・採点理由・モデル・Orca request IDで追跡する。
 */
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  mode: { type: 'string', default: 'fixture' },
  split: { type: 'string', default: 'development' },
  repetitions: { type: 'string' },
  cases: { type: 'string' },
  web: { type: 'string', default: 'fixture' },
  model: { type: 'string', default: 'openai/gpt-4o-mini' },
  'max-usd': { type: 'string' },
  'env-file': { type: 'string' },
  /** 調査用。モデルの応答本文をこのディレクトリへ書く（レポートには書かない）。合成ケースだけで使う。 */
  trace: { type: 'string' },
  'min-completion': { type: 'string', default: '0.8' },
  'min-fact-recall': { type: 'string', default: '0.7' },
  'max-prohibited-rate': { type: 'string', default: '0' },
  'min-citation-validity': { type: 'string', default: '0.95' },
} })

const mode = values.mode === 'live' ? 'live' as const : values.mode === 'fixture' ? 'fixture' as const : usage('--mode は fixture か live')
const split = ['development', 'holdout', 'all'].includes(values.split!) ? values.split as 'development' | 'holdout' | 'all' : usage('--split は development / holdout / all')
const web = values.web === 'official' ? 'official' as const : values.web === 'fixture' ? 'fixture' as const : usage('--web は fixture か official')
if (mode === 'fixture' && web === 'official') usage('fixtureモードは固定資料だけを使う')
const repetitions = number(values.repetitions ?? '3', '--repetitions', 1, 20)
const maxUsd = mode === 'live' ? number(values['max-usd'] ?? usage('liveモードには --max-usd が必要'), '--max-usd', 0.001, 20) : 0
const thresholds = {
  // fixtureは決定的なので、すべての試行が基準を満たすことを求める。
  completionRate: mode === 'fixture' ? 1 : number(values['min-completion']!, '--min-completion', 0, 1),
  factRecall: mode === 'fixture' ? 1 : number(values['min-fact-recall']!, '--min-fact-recall', 0, 1),
  prohibitedRate: mode === 'fixture' ? 0 : number(values['max-prohibited-rate']!, '--max-prohibited-rate', 0, 1),
  citationValidity: mode === 'fixture' ? 1 : number(values['min-citation-validity']!, '--min-citation-validity', 0, 1),
}
const wanted = values.cases ? new Set(values.cases.split(',')) : null
const selected = GUIDANCE_CASES.filter(item => (split === 'all' || item.split === split) && (!wanted || wanted.has(item.id)) &&
  // 資料本文を書き換えるケースは実ページでは再現できない。
  !(web === 'official' && item.patchSources))
if (!selected.length) usage('対象のケースがありません')

function usage(message: string): never {
  console.error(`${message}\nUsage: eval/guidance/run.ts [--mode fixture|live] [--split development|holdout|all] [--repetitions N] [--cases id,...]\n  live: --max-usd USD [--model provider/model] [--web fixture|official] [--env-file path]`)
  process.exit(2)
}
function number(value: string, name: string, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) usage(`${name} は ${min}〜${max}`)
  return parsed
}

const apiKey = mode === 'live' ? await readOrcaApiKey(values['env-file'] ?? new URL('../../../../.env', import.meta.url)) : null
let tracing: { caseId: string; repetition: number } | null = null
const traceDir = values.trace ? resolve(values.trace) : null
const target: TrialTarget = { mode, web, timeoutMs: mode === 'live' ? 180_000 : 20_000,
  ...(traceDir ? { trace: (role: string, text: string) => {
    if (!tracing) return
    const name = `${tracing.caseId}-${tracing.repetition}-${role}.json`
    void mkdir(traceDir, { recursive: true }).then(() => writeFile(resolve(traceDir, name), text, { mode: 0o600 }))
  } } : {}),
  ...(apiKey ? { models: { core: () => createOrcaModel({ apiKey, modelId: values.model!, timeoutMs: 90_000 }),
    research: () => createOrcaModel({ apiKey, modelId: values.model!, timeoutMs: 90_000 }) } } : {}) }

interface TrialRecord {
  caseId: string; split: GuidanceCase['split']; repetition: number; outcome: GuidanceCase['outcome']
  state: 'PASS' | 'FAIL'; reasons: string[]
  status: string | null; failure: string | null; elapsedMs: number
  score: TrialScore
  dropped: { kind: string; reason: string }[]; uncoveredQuestionIds: string[]
  calls: CallRecord[]
}

/** 1試行の合否と理由。理由は識別子だけで、本文を含めない。 */
function judge(item: GuidanceCase, observation: Awaited<ReturnType<typeof runTrial>>, score: TrialScore): string[] {
  const reasons: string[] = []
  if (observation.failure) reasons.push(`FAILURE:${observation.failure}`)
  if (item.outcome === 'needs_input') {
    if (observation.calls.length) reasons.push('MODEL_CALLED')
    if (score.itemCount) reasons.push('GUIDANCE_RETURNED')
  } else {
    if (!score.completed) reasons.push('NOT_COMPLETED')
    if (score.completed && score.factRecall < thresholds.factRecall) reasons.push(...score.missedFacts.map(id => `MISSED_FACT:${id}`))
    if (score.citationValidity !== null && score.citationValidity < thresholds.citationValidity) reasons.push('UNSUPPORTED_ITEM')
  }
  if (!score.contractValid && observation.output) reasons.push('CONTRACT')
  reasons.push(...score.prohibited.map(id => `PROHIBITED:${id}`))
  if (score.invalidCitations) reasons.push('INVALID_CITATION')
  if (score.missingExpectations) reasons.push('EXPECTED_MISSING_ABSENT')
  if (mode === 'fixture') {
    const dropped = new Set(observation.diagnostics?.dropped.map(entry => entry.reason) ?? [])
    for (const reason of item.fixtureDropped ?? []) if (!dropped.has(reason)) reasons.push(`DEFENSE_NOT_TRIGGERED:${reason}`)
  }
  return reasons
}

const revision = sourceRevision()
const reportPath = resolve(import.meta.dirname, '../../../../reports', `ai-eval-guidance-${mode}-${split}.json`)
const report = {
  schemaVersion: 1, evaluation: 'task_guidance', mode, web, split, ...revision,
  datasetVersion: contentHash(GUIDANCE_CASES.map(({ id, split: itemSplit, outcome, task, expectation }) =>
    ({ id, itemSplit, outcome, task, facts: expectation.requiredFacts, missing: expectation.expectedMissing.map(String) }))),
  scorer: 'deterministic-facts-prohibited-citations-v1',
  model: mode === 'live' ? values.model! : null,
  skills: skillCatalog.map(item => ({ id: item.id, version: item.version, hash: item.hash })),
  thresholds, repetitions, maxUsd: mode === 'live' ? maxUsd : null,
  caseIds: selected.map(item => item.id),
  startedAt: new Date().toISOString(),
  completed: false, passed: false, budgetExhausted: false,
  summary: null as null | Record<string, unknown>,
  trials: [] as TrialRecord[],
}
async function persist() {
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await rename(`${reportPath}.tmp`, reportPath)
}

// 実行前の見込み費用。実測が得られるまでは保守的な値を使う。
const FALLBACK_USD_PER_TOKEN = { input: 5 / 1e6, output: 15 / 1e6 }
const callCost = (call: CallRecord) => call.provisionalCostUsd ??
  ((call.inputTokens ?? 16_000) * FALLBACK_USD_PER_TOKEN.input + (call.outputTokens ?? 1_000) * FALLBACK_USD_PER_TOKEN.output)
let spentUsd = 0
// 次の試行の見込み。実測が無い間は保守的に0.05ドルとし、実測後は最大の実測値を使う。
let largestTrialUsd: number | null = null

try {
  outer: for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const item of selected) {
      if (mode === 'live' && spentUsd + (largestTrialUsd ?? 0.05) > maxUsd) { report.budgetExhausted = true; break outer }
      tracing = { caseId: item.id, repetition }
      const observation = await runTrial(item, target)
      const trialUsd = observation.calls.reduce((sum, call) => sum + callCost(call), 0)
      spentUsd += trialUsd
      if (observation.calls.length) largestTrialUsd = Math.max(largestTrialUsd ?? 0, trialUsd)
      const score = scoreGuidance(observation.output, item.expectation, observation.sources)
      const reasons = judge(item, observation, score)
      report.trials.push({ caseId: item.id, split: item.split, repetition, outcome: item.outcome, state: reasons.length ? 'FAIL' : 'PASS', reasons,
        status: observation.output?.status ?? null, failure: observation.failure, elapsedMs: Math.round(observation.elapsedMs), score,
        dropped: observation.diagnostics?.dropped ?? [], uncoveredQuestionIds: observation.diagnostics?.uncoveredQuestionIds ?? [],
        calls: observation.calls.map(call => ({ ...call, latencyMs: Math.round(call.latencyMs) })) })
      await persist()
      console.error(`[${repetition}/${repetitions}] ${item.id}: ${reasons.length ? `FAIL ${reasons.join(',')}` : 'PASS'} (${Math.round(observation.elapsedMs)}ms)`)
    }
  }
  if (apiKey) {
    // 確定費用は精算後に取れるため、全試行の後でまとめて取得する。
    for (const call of report.trials.flatMap(trial => trial.calls)) if (call.requestId) call.finalCostUsd = await finalCostUsd(call.requestId, apiKey)
  }
  report.summary = summarize(report.trials)
  const summary = report.summary as ReturnType<typeof summarize>
  report.completed = !report.budgetExhausted && report.trials.length === selected.length * repetitions
  report.passed = report.completed && summary.guidance.completionRate >= thresholds.completionRate &&
    (summary.guidance.meanFactRecall ?? 0) >= thresholds.factRecall && summary.guidance.prohibitedRate <= thresholds.prohibitedRate &&
    (summary.guidance.meanCitationValidity ?? 0) >= thresholds.citationValidity && summary.contractViolations === 0 &&
    summary.invalidCitations === 0 && summary.needsInput.correctRate === 1 &&
    (mode === 'live' || report.trials.every(trial => trial.state === 'PASS'))
} finally { await persist() }

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null
}
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
function round(value: number | null, digits = 4) { return value === null ? null : Number(value.toFixed(digits)) }

function summarize(trials: TrialRecord[]) {
  const guidance = trials.filter(trial => trial.outcome === 'guidance')
  const needsInput = trials.filter(trial => trial.outcome === 'needs_input')
  const completed = guidance.filter(trial => trial.score.completed)
  const calls = trials.flatMap(trial => trial.calls)
  const sum = (pick: (call: CallRecord) => number | null) => {
    const picked = calls.map(pick)
    return picked.every(value => value !== null) ? round(picked.reduce<number>((a, b) => a + b!, 0), 6) : null
  }
  const count = <T extends string>(items: T[]) => Object.fromEntries([...new Set(items)].sort().map(key => [key, items.filter(item => item === key).length]))
  const facts = new Map<FactId, { required: number; hit: number }>()
  for (const trial of completed) {
    const item = selected.find(entry => entry.id === trial.caseId)!
    for (const id of item.expectation.requiredFacts) {
      const entry = facts.get(id) ?? { required: 0, hit: 0 }
      entry.required++
      if (!trial.score.missedFacts.includes(id)) entry.hit++
      facts.set(id, entry)
    }
  }
  // 同じケースの繰り返しで、確認できた事実の組み合わせが変わった割合（揺れ）。
  const byCase = Object.fromEntries(selected.map(item => {
    const runs = trials.filter(trial => trial.caseId === item.id)
    const recalls = runs.filter(trial => trial.score.completed).map(trial => trial.score.factRecall)
    const recallMean = mean(recalls)
    return [item.id, { split: item.split, runs: runs.length, passRate: round(runs.filter(trial => trial.state === 'PASS').length / Math.max(1, runs.length)),
      meanFactRecall: round(recallMean), factRecallStdDev: round(recallMean === null ? null : Math.sqrt(mean(recalls.map(value => (value - recallMean) ** 2))!)),
      distinctFactSets: new Set(runs.map(trial => trial.score.missedFacts.join(','))).size,
      itemCountRange: runs.length ? [Math.min(...runs.map(trial => trial.score.itemCount)), Math.max(...runs.map(trial => trial.score.itemCount))] : null }]
  }))
  const latencies = trials.filter(trial => trial.outcome === 'guidance').map(trial => trial.elapsedMs)
  return {
    trials: trials.length,
    guidance: {
      trials: guidance.length,
      completionRate: round(completed.length / Math.max(1, guidance.length))!,
      meanFactRecall: round(mean(completed.map(trial => trial.score.factRecall))),
      /** 禁止主張を1件以上含んだ試行の割合。 */
      prohibitedRate: round(guidance.filter(trial => trial.score.prohibited.length).length / Math.max(1, guidance.length))!,
      meanCitationValidity: round(mean(completed.map(trial => trial.score.citationValidity).filter((value): value is number => value !== null))),
      failures: count(guidance.map(trial => trial.failure).filter((value): value is string => value !== null)),
    },
    needsInput: { trials: needsInput.length, correctRate: needsInput.length ? round(needsInput.filter(trial => trial.state === 'PASS').length / needsInput.length)! : 1 },
    contractViolations: trials.filter(trial => !trial.score.contractValid && trial.status !== null).length,
    invalidCitations: trials.reduce((total, trial) => total + trial.score.invalidCitations, 0),
    prohibitedByKind: count(trials.flatMap(trial => trial.score.prohibited) as ProhibitedId[]),
    factHitRate: Object.fromEntries([...facts].map(([id, entry]) => [id, { label: REQUIRED_FACTS[id].label, hitRate: round(entry.hit / entry.required), required: entry.required }])),
    /** ハーネスが根拠なしとして除いた主張の件数（モデルが根拠を超えて書こうとした頻度）。 */
    droppedByReason: count(trials.flatMap(trial => trial.dropped.map(entry => entry.reason))),
    uncoveredQuestions: count(trials.flatMap(trial => trial.uncoveredQuestionIds)),
    byCase,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    modelLatencyMs: { p50: percentile(calls.map(call => call.latencyMs), 0.5), p95: percentile(calls.map(call => call.latencyMs), 0.95) },
    tokens: { input: sum(call => call.inputTokens), output: sum(call => call.outputTokens), calls: calls.length, failedCalls: calls.filter(call => !call.ok).length },
    costUsd: mode === 'live' ? {
      provisional: sum(call => call.provisionalCostUsd), final: sum(call => call.finalCostUsd),
      finalMissing: calls.filter(call => call.finalCostUsd === null).length,
      budgetAccounted: round(spentUsd, 6), maxUsd,
      perGuidanceTrial: round(mean(guidance.map(trial => trial.calls.reduce((total, call) => total + (call.finalCostUsd ?? call.provisionalCostUsd ?? 0), 0))), 6),
    } : null,
  }
}

const summary = report.summary as ReturnType<typeof summarize> | null
console.log(JSON.stringify({ report: reportPath, mode, split, web, model: report.model, trials: report.trials.length, completed: report.completed, passed: report.passed,
  budgetExhausted: report.budgetExhausted, completionRate: summary?.guidance.completionRate, meanFactRecall: summary?.guidance.meanFactRecall,
  prohibitedRate: summary?.guidance.prohibitedRate, meanCitationValidity: summary?.guidance.meanCitationValidity,
  latencyMs: summary?.latencyMs, tokens: summary?.tokens, costUsd: summary?.costUsd }, null, 2))
if (!report.passed) process.exitCode = 1
