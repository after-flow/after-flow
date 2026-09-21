import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { startConfiguredAiService } from '../../src/infrastructure/execution/composition.js'
import type { AiServiceComposition } from '../../src/infrastructure/execution/composition.js'
import { scriptedModel } from '../helpers/scripted-model.js'

const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }
test('composition validates reviewed bindings, owns HTTP/worker/storage and keeps unavailable operations closed', options, async () => {
  const expiry = new Date(Date.now() + 60000).toISOString(), reviewedAt = new Date(Date.now() - 60000).toISOString()
  const config: AiServiceComposition = {
    serviceToken: 'composition-fixture', backend: { baseUrl: 'https://backend.invalid', serviceToken: 'synthetic' }, runtimeEncryptionKey: randomBytes(32).toString('base64'),
    budget: { tools: 20, research: 2, searches: 6, reads: 12, inferenceAttempts: 24, replans: 2, tokens: 10000, costMicros: 100000, activeMs: 120000 }, sectionTimeoutMs: 30000,
    policies: ['first', 'second'].map(id => ({ id, revision: 'v1', sdkProvider: id, modelId: 'scripted', roles: ['core', 'research'], dataClasses: ['minimized_case', 'public_research'],
      approvedAt: reviewedAt, expiresAt: expiry, reviewReference: 'synthetic-policy', trainingUse: false, retentionDays: 0,
      capabilities: { tools: true, structuredOutput: true, japanese: true }, currency: 'USD', maxInputTokens: 1000, maxOutputTokens: 100, inputMicrosPerToken: 1, outputMicrosPerToken: 2 })),
    models: new Map(['first', 'second'].map(id => [id, { ...scriptedModel([]).model, provider: id }])),
    orch: { route: async () => assert.fail('no inference during bootstrap') }, grant: async () => assert.fail('no transfer during bootstrap'),
    recordMetric: async () => assert.fail('no inference during bootstrap'), researchScope: async () => assert.fail('no execution during bootstrap'),
    catalogs: [{ id: 'catalog', version: 'v1', reviewedAt, expiresAt: expiry, reviewReference: 'synthetic', allowedHosts: ['official.example'],
      entries: [{ id: 'source', catalogId: 'catalog', title: '合成資料', issuer: '合成機関', url: 'https://official.example/procedure', keywords: ['必要書類'] }] }],
    templates: [{ id: 'template', version: 'v1', reviewedAt, expiresAt: expiry, reviewReference: 'synthetic', sourceCatalogIds: ['catalog'],
      task: { title: '合成手続き', summary: '', stage: 'government', category: 'fixture', submitTo: '合成機関', evidenceRequired: true, assetDisposal: false }, prerequisites: [], requiredDocuments: ['合成資料'] }],
    maxSourceAgeMs: 60000, sourceTimeoutMs: 1000,
  }
  await assert.rejects(startConfiguredAiService({ ...config, models: new Map() }, { port: 0 }), /binding/)
  const previousDatabase = process.env.AI_RUNTIME_DATABASE_ID
  process.env.AI_RUNTIME_DATABASE_ID = `ai-runtime-composition-${randomUUID()}`
  const host = await startConfiguredAiService(config, { port: 0, shutdownMs: 10000 })
  try {
    const origin = `http://127.0.0.1:${host.port}/internal/v1`
    assert.equal((await fetch(`${origin}/health`)).status, 200)
    const seconds = Math.floor(Date.now() / 1000)
    const body = { cancelId: randomUUID(), runId: randomUUID(), jobId: randomUUID(), executionAttempt: randomUUID(), issuedAt: seconds, expiresAt: seconds + 60 }
    const headers = { Authorization: 'Bearer composition-fixture', 'X-Audience': 'ai-server', 'Content-Type': 'application/json', 'X-Request-Id': body.cancelId, 'Idempotency-Key': body.cancelId }
    const cancel = () => fetch(`${origin}/runs/${body.runId}/cancel`, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal((await (await cancel()).json() as { status: string }).status, 'STOPPED')
    assert.equal((await (await cancel()).json() as { status: string }).status, 'DUPLICATE')
    const dispatch = { runId: body.runId, jobId: body.jobId, executionAttempt: body.executionAttempt, issuedAt: seconds, expiresAt: seconds + 60,
      operation: 'document_analysis', executionAuthorization: 'synthetic-unusable-capability' }
    assert.equal((await fetch(`${origin}/runs/${body.runId}/dispatch`, { method: 'POST',
      headers: { ...headers, 'X-Request-Id': body.jobId, 'Idempotency-Key': body.jobId }, body: JSON.stringify(dispatch) })).status, 503)
  } finally {
    try { assert.equal(await host.stop(), true); await host.done }
    finally { if (previousDatabase === undefined) delete process.env.AI_RUNTIME_DATABASE_ID; else process.env.AI_RUNTIME_DATABASE_ID = previousDatabase }
  }
})
