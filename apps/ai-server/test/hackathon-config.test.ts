import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readHackathonComposition } from '../src/infrastructure/execution/hackathon-config.js'
import { assertResearchScopeCatalogs } from '../src/infrastructure/execution/composition.js'
import { createOfficialCatalogProvider } from '../src/infrastructure/research/official-catalog.js'
import { findProcedureDefinition } from '@aftercare/internal-contracts'

const valid = (): NodeJS.ProcessEnv => ({
  AI_RUNTIME_MODE: 'hackathon',
  ORCAROUTER_API_KEY: 'synthetic-never-live',
  AI_SERVICE_TOKEN: 'synthetic-inbound-service-token',
  AI_SERVICE_AUDIENCE: 'ai-server',
  AI_RUNTIME_ENCRYPTION_KEY: 'YWZ0ZXItZmxvdy1oYWNrYXRob24tcnVudGltZS1rZXk=',
  BACKEND_INTERNAL_URL: 'http://backend-server:8080',
  BACKEND_INTERNAL_SERVICE_TOKEN: 'synthetic-backend-service-token',
  BACKEND_SERVICE_AUDIENCE: 'backend-internal',
})

test('auto mode stays liveness-only without a key and explicit hackathon mode fails closed', () => {
  assert.equal(readHackathonComposition({ AI_RUNTIME_MODE: 'auto' }), null)
  assert.equal(readHackathonComposition({ AI_RUNTIME_MODE: 'disabled', ORCAROUTER_API_KEY: 'present' }), null)
  assert.throws(() => readHackathonComposition({ AI_RUNTIME_MODE: 'hackathon' }))
  assert.throws(() => readHackathonComposition({ ...valid(), NODE_ENV: 'production' }), /cannot run in production/)
})

test('hackathon composition binds two model families, fixed official sources and bounded grant', async () => {
  const metrics: Record<string, unknown>[] = []
  const config = readHackathonComposition(valid(), metric => { metrics.push({ ...metric }) })
  assert.ok(config && config.orca)
  assert.deepEqual(config.policies.map(policy => policy.modelId), ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'])
  assert.equal(new Set(config.policies.map(policy => policy.sdkProvider)).size, 2)
  assert.deepEqual(config.catalogs.map(catalog => catalog.id), [
    'kyoukaikenpo-burial-benefit', 'nenkin-death-procedures', 'inheritance-renunciation',
    'final-income-tax-return', 'inheritance-tax-return', 'real-estate-registration',
  ])
  const sourceIds = config.catalogs.flatMap(catalog => catalog.entries.map(entry => entry.id))
  assert.equal(new Set(sourceIds).size, sourceIds.length)
  for (const catalog of config.catalogs) {
    assert.ok(catalog.entries.every(entry => entry.catalogId === catalog.id && catalog.allowedHosts.includes(new URL(entry.url).hostname)))
  }
  const procedureCatalogs = {
    'pension-stop': 'nenkin-death-procedures',
    'unpaid-pension-claim': 'nenkin-death-procedures',
    'survivor-pension-check': 'nenkin-death-procedures',
    'death-lump-sum-check': 'nenkin-death-procedures',
    'inheritance-choice': 'inheritance-renunciation',
    'inheritance-renunciation': 'inheritance-renunciation',
    'final-income-tax-return': 'final-income-tax-return',
    'inheritance-tax-return': 'inheritance-tax-return',
    'real-estate-registration': 'real-estate-registration',
  } as const
  for (const [procedureId, catalogId] of Object.entries(procedureCatalogs)) {
    assert.deepEqual(findProcedureDefinition(procedureId)?.guidance.researchScope.sourceCatalogIds, [catalogId])
  }
  const provider = createOfficialCatalogProvider(config.catalogs, { now: () => Date.parse('2026-09-22T12:00:00.000Z') })
  const signal = new AbortController().signal
  const searches = [
    ['nenkin-death-procedures', '日本年金機構 未支給年金'],
    ['inheritance-renunciation', '裁判所 相続放棄'],
    ['final-income-tax-return', '国税庁 準確定申告'],
    ['inheritance-tax-return', '国税庁 相続税'],
    ['real-estate-registration', '法務局 相続登記'],
  ] as const
  for (const [catalogId, query] of searches) {
    const results = await provider.search({ query, catalogIds: [catalogId], signal })
    assert.ok(results.length > 0, catalogId)
    assert.ok(results.every(candidate => candidate.catalogId === catalogId))
  }
  const restarted = readHackathonComposition(valid())!
  assert.equal(restarted.catalogs[0]?.reviewedAt, config.catalogs[0]?.reviewedAt)
  assert.equal(restarted.catalogs[0]?.expiresAt, config.catalogs[0]?.expiresAt)
  assert.equal(restarted.policies[0]?.approvedAt, config.policies[0]?.approvedAt)
  const scope = await config.researchScope({} as never)
  assert.equal(assertResearchScopeCatalogs(scope, config.catalogs).procedureIds[0], 'kyoukaikenpo-burial-benefit')
  assert.throws(() => assertResearchScopeCatalogs({ ...scope, sourceCatalogVersions: { [scope.sourceCatalogIds[0]!]: 'stale' } }, config.catalogs), /version mismatch/)
  const grant = await config.grant({} as never)
  assert.deepEqual(grant.providerPolicyIds, ['orca-core-primary', 'orca-core-fallback'])
  assert.deepEqual(grant.dataClasses, ['minimized_case', 'public_research'])
  assert.equal(grant.maxRetentionDays, 0)
  await config.recordMetric({ attemptId: 'provider-attempt', policyId: 'orca-core-primary', policyRevision: 'hackathon-v1', modelId: 'openai/gpt-4o-mini', routeEvidenceId: null,
    role: 'core', fallbackFromPolicyId: null, status: 'success', durationMs: 1, inputTokens: 2, outputTokens: 3,
    estimatedCostUsd: 0.00008, gatewayReportedCostUsd: null, failure: null },
  { runId: 'run', jobId: 'job', executionAttempt: 'attempt' })
  assert.deepEqual(metrics, [{ event: 'ai_provider_attempt', runId: 'run', jobId: 'job', executionAttempt: 'attempt',
    attemptId: 'provider-attempt', policyId: 'orca-core-primary', policyRevision: 'hackathon-v1', modelId: 'openai/gpt-4o-mini', routeEvidenceId: null,
    role: 'core', fallbackFromPolicyId: null, status: 'success', durationMs: 1, inputTokens: 2, outputTokens: 3,
    estimatedCostUsd: 0.00008, gatewayReportedCostUsd: null, failure: null }])
})

test('hackathon composition rejects shared credentials and same-family fallback', () => {
  assert.throws(() => readHackathonComposition({ ...valid(),
    BACKEND_INTERNAL_SERVICE_TOKEN: valid().AI_SERVICE_TOKEN }), /must differ/)
  assert.throws(() => readHackathonComposition({ ...valid(),
    AI_ORCA_FALLBACK_MODEL: 'openai/gpt-4.1-mini' }), /distinct model families/)
})
