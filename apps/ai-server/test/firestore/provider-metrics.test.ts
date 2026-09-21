import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { FirestoreProviderMetrics } from '../../src/infrastructure/runtime-storage/provider-metrics.js'

const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }

test('provider attempts persist by run without prompt, response or credentials', options, async () => {
  const db = createRuntimeFirestore(), store = new FirestoreProviderMetrics(db, () => Date.parse('2026-09-22T00:00:00Z'))
  const suffix = randomUUID(), runId = `run-${suffix}`
  const metric = {
    attemptId: `attempt-${suffix}`, policyId: 'policy-one', policyRevision: 'revision-one', modelId: 'openai/model',
    routeEvidenceId: null, selectionId: 'selection-one', role: 'research' as const, fallbackFromPolicyId: 'policy-primary',
    status: 'success' as const, durationMs: 25, inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.001,
    gatewayReportedCostUsd: 0.0012, failure: null,
    gateway: { gateway: 'orcarouter' as const, requestId: `orca-${suffix}`, requestedModel: 'openai/model', resolvedModel: 'openai/model', fallbackModel: null, costUsd: 0.0012 },
  }
  try {
    await store.record(metric, { runId, jobId: `job-${suffix}`, executionAttempt: `execution-${suffix}` })
    const records = await store.listRun(runId)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.gatewayRequestId, `orca-${suffix}`)
    assert.equal(records[0]?.fallbackFromPolicyId, 'policy-primary')
    const serialized = JSON.stringify(records)
    for (const forbidden of ['prompt', 'responseBody', 'apiKey', 'PRIVATE-NAME']) assert.equal(serialized.includes(forbidden), false)
    await assert.rejects(store.record({ ...metric, attemptId: metric.attemptId },
      { runId, jobId: `job-${suffix}`, executionAttempt: `execution-${suffix}` }))
  } finally {
    const snapshots = await db.collection('provider_metrics').where('runId', '==', runId).get()
    await Promise.all(snapshots.docs.map(doc => doc.ref.delete()))
    await db.terminate()
  }
})
