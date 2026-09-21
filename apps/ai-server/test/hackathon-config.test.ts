import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readHackathonComposition } from '../src/infrastructure/execution/hackathon-config.js'
import { assertResearchScopeCatalogs } from '../src/infrastructure/execution/composition.js'

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
  assert.deepEqual(config.catalogs[0]?.allowedHosts, ['www.kyoukaikenpo.or.jp'])
  assert.ok(config.catalogs[0]?.entries.every(entry => new URL(entry.url).hostname === 'www.kyoukaikenpo.or.jp'))
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
  await config.recordMetric({ policyId: 'orca-core-primary', policyRevision: 'hackathon-v1', routeEvidenceId: null,
    role: 'core', status: 'success', durationMs: 1, inputTokens: 2, outputTokens: 3, failure: null },
  { runId: 'run', jobId: 'job', executionAttempt: 'attempt' })
  assert.deepEqual(metrics, [{ event: 'ai_provider_attempt', runId: 'run', jobId: 'job', executionAttempt: 'attempt',
    policyId: 'orca-core-primary', policyRevision: 'hackathon-v1', routeEvidenceId: null,
    role: 'core', status: 'success', durationMs: 1, inputTokens: 2, outputTokens: 3, failure: null }])
})

test('hackathon composition rejects shared credentials and same-family fallback', () => {
  assert.throws(() => readHackathonComposition({ ...valid(),
    BACKEND_INTERNAL_SERVICE_TOKEN: valid().AI_SERVICE_TOKEN }), /must differ/)
  assert.throws(() => readHackathonComposition({ ...valid(),
    AI_ORCA_FALLBACK_MODEL: 'openai/gpt-4.1-mini' }), /distinct model families/)
})
