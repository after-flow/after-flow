import { createHash } from 'node:crypto'
import type { Firestore } from '@google-cloud/firestore'
import { z } from 'zod'
import { internalId } from '@aftercare/internal-contracts'
import type { ProviderMetric } from '../mastra/authorized-models.js'

const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const providerMetricRecordSchema = z.object({
  attemptId: safeId,
  runId: internalId,
  jobId: internalId,
  executionAttempt: internalId,
  policyId: internalId,
  policyRevision: internalId,
  modelId: z.string().min(1).max(200),
  routeEvidenceId: z.string().min(1).max(256).nullable(),
  selectionId: z.string().min(1).max(256).nullable(),
  gatewayRequestId: safeId.nullable(),
  gatewayResolvedModel: z.string().min(1).max(200).nullable(),
  gatewayFallbackModel: z.string().min(1).max(200).nullable(),
  role: z.enum(['core', 'research']),
  fallbackFromPolicyId: internalId.nullable(),
  status: z.enum(['success', 'failure']),
  failure: z.enum(['TRANSIENT', 'PERMANENT', 'INTERRUPTED']).nullable(),
  durationMs: z.number().int().nonnegative().safe(),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  estimatedCostUsd: z.number().nonnegative().finite().nullable(),
  gatewayReportedCostUsd: z.number().nonnegative().finite().nullable(),
  createdAt: z.string().datetime(),
}).strict()
export type ProviderMetricRecord = z.infer<typeof providerMetricRecordSchema>

/** AI runtime-only telemetry. It intentionally has no prompt, response, Case or credential fields. */
export class FirestoreProviderMetrics {
  constructor(private readonly db: Firestore, private readonly now: () => number = Date.now) {}

  async record(metric: ProviderMetric, identity: { runId: string; jobId: string; executionAttempt: string }): Promise<ProviderMetricRecord> {
    const record = providerMetricRecordSchema.parse({
      attemptId: metric.attemptId,
      ...identity,
      policyId: metric.policyId,
      policyRevision: metric.policyRevision,
      modelId: metric.modelId,
      routeEvidenceId: metric.routeEvidenceId,
      selectionId: metric.selectionId ?? null,
      gatewayRequestId: metric.gateway?.requestId ?? null,
      gatewayResolvedModel: metric.gateway?.resolvedModel ?? null,
      gatewayFallbackModel: metric.gateway?.fallbackModel ?? null,
      role: metric.role,
      fallbackFromPolicyId: metric.fallbackFromPolicyId,
      status: metric.status,
      failure: metric.failure,
      durationMs: metric.durationMs,
      inputTokens: metric.inputTokens,
      outputTokens: metric.outputTokens,
      estimatedCostUsd: metric.estimatedCostUsd,
      gatewayReportedCostUsd: metric.gatewayReportedCostUsd,
      createdAt: new Date(this.now()).toISOString(),
    })
    const key = createHash('sha256').update(record.attemptId).digest('hex')
    await this.db.collection('provider_metrics').doc(key).create(record)
    return record
  }

  async listRun(runId: string): Promise<ProviderMetricRecord[]> {
    internalId.parse(runId)
    const snapshot = await this.db.collection('provider_metrics').where('runId', '==', runId).get()
    return snapshot.docs.map(doc => providerMetricRecordSchema.parse(doc.data()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptId.localeCompare(b.attemptId))
  }
}
