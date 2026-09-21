import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcileOrcaCosts } from '../src/infrastructure/orcarouter/cost-reconciliation.js'

const metric = (requestId: string) => ({
  attemptId: `attempt-${requestId}`, runId: 'run-one', jobId: 'job-one', executionAttempt: 'execution-one',
  policyId: 'policy-one', policyRevision: 'revision-one', modelId: 'openai/model', routeEvidenceId: null,
  selectionId: 'selection-one', gatewayRequestId: requestId, gatewayResolvedModel: 'openai/model', gatewayFallbackModel: null,
  role: 'core', fallbackFromPolicyId: null, status: 'success', failure: null, durationMs: 10,
  inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01, gatewayReportedCostUsd: 0.012,
  createdAt: '2026-09-22T00:00:00.000Z',
})

test('confirmed billing costs stay separate from provisional metric values', () => {
  const report = reconcileOrcaCosts([metric('orca-one'), metric('orca-two')], [
    { requestId: 'orca-one', confirmedCostUsd: 0.011 }, { requestId: 'unknown', confirmedCostUsd: 1 },
  ])
  assert.equal(report.matched[0]?.deltaUsd, -0.001)
  assert.deepEqual(report.missingConfirmedRequestIds, ['orca-two'])
  assert.deepEqual(report.unknownConfirmedRequestIds, ['unknown'])
  assert.deepEqual(report.totals, { estimatedCostUsd: 0.01, gatewayReportedCostUsd: 0.012, confirmedCostUsd: 0.011 })
  assert.throws(() => reconcileOrcaCosts([metric('orca-one')], [
    { requestId: 'orca-one', confirmedCostUsd: 1 }, { requestId: 'orca-one', confirmedCostUsd: 2 },
  ]), /Duplicate/)
})
