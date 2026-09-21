import type { MastraModelConfig } from '@mastra/core/llm'
import type { InternalResult } from '@aftercare/internal-contracts'
import { contentHash } from '../../src/orchestration/context/builder.js'
import { createProcedureGuidanceWorkflow } from '../../src/infrastructure/mastra/workflows/procedure-guidance.js'
import type { ProcedureGuidanceDependencies } from '../../src/infrastructure/mastra/workflows/procedure-guidance.js'
import { BURIAL_CATALOG_ENTRIES, BURIAL_CATALOG_ID, burialGuidanceScope } from '../../src/infrastructure/execution/hackathon-config.js'
import { createOfficialCatalogProvider } from '../../src/infrastructure/research/official-catalog.js'
import type { GuidanceDiagnostics } from '../../src/orchestration/playbooks/guidance-output.js'
import type { SourceDocument } from '../../src/orchestration/research/sources.js'
import { scriptedModel } from '../../test/helpers/scripted-model.js'
import { FIXTURE_DRAFT, FIXTURE_RESEARCH } from './cases.js'
import type { GuidanceCase } from './cases.js'
import { meteredModel } from './meter.js'
import type { CallRecord } from './meter.js'
import { fixtureSources, rebuildDocument } from './sources.js'
import { guidanceOutputOf } from './scoring.js'
import type { GuidanceOutput } from './scoring.js'

type Model = Extract<MastraModelConfig, { specificationVersion: 'v2' }>
const ALLOWED_HOSTS = ['www.kyoukaikenpo.or.jp']
const TASK = { title: '健康保険の埋葬料（費）を確認する', category: 'insurance-benefit', submitTo: '全国健康保険協会',
  summary: '加入状況と申請者の関係に応じて、支給条件と必要書類を確認します。' }

export interface TrialTarget {
  mode: 'fixture' | 'live'
  web: 'fixture' | 'official'
  /** liveで使うモデル。fixtureでは使わない。 */
  models?: { core: () => Model; research: () => Model }
  timeoutMs: number
  /** 調査用。モデルの応答本文を受け取る。レポートには書かない。 */
  trace?: (role: CallRecord['role'], text: string) => void
}

export interface TrialObservation {
  output: GuidanceOutput | null
  /** 本文を含まない失敗の分類。 */
  failure: string | null
  diagnostics: GuidanceDiagnostics | null
  calls: CallRecord[]
  elapsedMs: number
  /** 採点に使った資料。引用の照合に使う。 */
  sources: SourceDocument[]
}

/** ワークフローの失敗を、本文を含まない分類に変える。 */
export function classifyFailure(error: unknown): string {
  // Mastraは失敗したstepのエラーを直列化して返すことがあるため、messageを持つ値も扱う。
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
  const known: [RegExp, string][] = [
    [/Structured output/i, 'STRUCTURED_OUTPUT_INVALID'],
    [/Research omitted required questions|Unresolved research/i, 'RESEARCH_INCOMPLETE'],
    [/OrcaRouter|provider|fetch failed|status code/i, 'PROVIDER_ERROR'],
    [/abort|timeout/i, 'TIMEOUT'],
    [/Guidance sources expired|CONTEXT_CHANGED|EXPIRED_CONTEXT/, 'STALE_INPUT'],
    [/cites a source which was not retrieved/, 'UNRETRIEVED_SOURCE'],
    [/Invalid|too_big|ZodError|expected/i, 'CONTRACT_VIOLATION'],
  ]
  return known.find(([pattern]) => pattern.test(message))?.[1] ?? `OTHER:${error instanceof Error ? error.name : 'unknown'}`
}

function artifactFor(item: GuidanceCase) {
  const content = { operation: 'task_guidance',
    case: { id: 'eval-case', version: 1, deceasedName: '評価用の架空の人物', municipality: '架空市', knownAt: null, dateOfDeath: '2026-09-01' },
    task: { id: 'eval-task', version: 1, ...TASK, ...item.task }, documents: [] }
  return { caseVersion: 1, contextSnapshotId: 'eval-snapshot', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), content }
}

/** 1ケースを1回実行する。Backendは模擬し、ワークフロー・Agent・検証は本番と同じものを使う。 */
export async function runTrial(item: GuidanceCase, target: TrialTarget): Promise<TrialObservation> {
  const calls: CallRecord[] = []
  const reported: InternalResult[] = []
  let diagnostics: GuidanceDiagnostics | null = null
  const reviewedAt = new Date(Date.now() - 60_000).toISOString()
  const read: SourceDocument[] = []
  const patch = (source: SourceDocument) => {
    const patched = item.patchSources ? rebuildDocument(item.patchSources([source])[0]!) : source
    read.push(patched)
    return patched
  }
  const fixtures = new Map(fixtureSources().map(source => [source.id, source]))
  const official = createOfficialCatalogProvider([{ id: BURIAL_CATALOG_ID, version: 'eval', reviewedAt, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    reviewReference: 'eval', allowedHosts: ALLOWED_HOSTS, entries: BURIAL_CATALOG_ENTRIES.map(entry => ({ ...entry, keywords: [...entry.keywords] })) }])
  const research: ProcedureGuidanceDependencies['research'] = target.web === 'official'
    ? { search: input => official.search(input), read: async input => patch(await official.read(input)) }
    : {
        async search() { return BURIAL_CATALOG_ENTRIES.map(({ id, catalogId, title, issuer, url }) => ({ id, catalogId, title, issuer, url })) },
        async read({ candidate }) {
          const source = fixtures.get(candidate.id)
          if (!source) throw new Error('Unknown fixture source')
          return patch(source)
        },
      }
  const models = target.mode === 'live'
    ? { core: meteredModel(target.models!.core(), 'core', record => calls.push(record), target.trace && (text => target.trace!('core', text))),
        research: meteredModel(target.models!.research(), 'research', record => calls.push(record), target.trace && (text => target.trace!('research', text))) }
    : { core: meteredModel(scriptedModel([{ text: JSON.stringify((item.fixtureCore ?? (draft => draft))(FIXTURE_DRAFT)) }]).model, 'core', record => calls.push(record)),
        research: meteredModel(scriptedModel([{ text: JSON.stringify(FIXTURE_RESEARCH) }]).model, 'research', record => calls.push(record)) }
  const artifact = artifactFor(item)
  const signal = AbortSignal.timeout(target.timeoutMs)
  const workflow = createProcedureGuidanceWorkflow({
    backend: {
      async control() { return { instruction: 'CONTINUE', reason: null, caseVersion: 1 } },
      async context() { return structuredClone(artifact) },
      async result(value) { reported.push(value); return { applied: true, reason: null } },
    },
    models, scope: burialGuidanceScope(reviewedAt), catalogs: [{ id: BURIAL_CATALOG_ID, allowedHosts: ALLOWED_HOSTS }],
    research, signal, maxSourceAgeMs: 15 * 60_000, timeoutMs: 10_000,
    async authorizeRoute() { return { routeId: 'procedure-guidance/v1', evidenceId: 'eval-harness' } },
    async beforeTool() {},
    observeGuidance: value => { diagnostics = value },
  })
  const started = performance.now()
  let failure: string | null = null
  try {
    const run = await workflow.createRun()
    const result = await run.start({ inputData: { resultId: `eval-${item.id}` } })
    if (result.status !== 'success') failure = classifyFailure(result.status === 'failed' ? result.error : new Error(result.status))
  } catch (error) { failure = classifyFailure(error) }
  const elapsedMs = performance.now() - started
  const output = reported.length === 1 ? guidanceOutputOf(reported[0]) : null
  if (!failure && !output) failure = 'NO_RESULT'
  return { output, failure, diagnostics, calls, elapsedMs, sources: read.length ? read : [...fixtures.values()] }
}
