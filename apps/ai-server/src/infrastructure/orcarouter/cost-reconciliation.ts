import { z } from 'zod'
import { providerMetricRecordSchema } from '../runtime-storage/provider-metrics.js'

export const confirmedOrcaCostSchema = z.object({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  confirmedCostUsd: z.number().nonnegative().finite(),
}).strict()

export const costReconciliationSchema = z.object({
  matched: z.array(z.object({
    requestId: z.string(), runId: z.string(), estimatedCostUsd: z.number().nullable(),
    gatewayReportedCostUsd: z.number().nullable(), confirmedCostUsd: z.number(), deltaUsd: z.number().nullable(),
  }).strict()),
  missingConfirmedRequestIds: z.array(z.string()),
  unknownConfirmedRequestIds: z.array(z.string()),
  totals: z.object({ estimatedCostUsd: z.number(), gatewayReportedCostUsd: z.number(), confirmedCostUsd: z.number() }).strict(),
}).strict()

/** Reconciles a reviewed billing/dashboard export without assuming an undocumented Orca API. */
export function reconcileOrcaCosts(metricInput: unknown, confirmedInput: unknown) {
  const money = (value: number) => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000
  const metrics = z.array(providerMetricRecordSchema).parse(metricInput).filter(metric => metric.gatewayRequestId !== null)
  const confirmed = z.array(confirmedOrcaCostSchema).parse(confirmedInput)
  if (new Set(confirmed.map(item => item.requestId)).size !== confirmed.length) throw new Error('Duplicate confirmed Orca request ID')
  const byRequest = new Map(confirmed.map(item => [item.requestId, item]))
  const metricIds = new Set(metrics.map(metric => metric.gatewayRequestId!))
  const matched = metrics.flatMap(metric => {
    const value = byRequest.get(metric.gatewayRequestId!)
    if (!value) return []
    const provisional = metric.gatewayReportedCostUsd ?? metric.estimatedCostUsd
    return [{ requestId: value.requestId, runId: metric.runId, estimatedCostUsd: metric.estimatedCostUsd,
      gatewayReportedCostUsd: metric.gatewayReportedCostUsd, confirmedCostUsd: value.confirmedCostUsd,
      deltaUsd: provisional === null ? null : money(value.confirmedCostUsd - provisional) }]
  })
  return costReconciliationSchema.parse({
    matched,
    missingConfirmedRequestIds: [...new Set(metrics.map(metric => metric.gatewayRequestId!).filter(id => !byRequest.has(id)))].sort(),
    unknownConfirmedRequestIds: confirmed.map(item => item.requestId).filter(id => !metricIds.has(id)).sort(),
    totals: {
      estimatedCostUsd: money(matched.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)),
      gatewayReportedCostUsd: money(matched.reduce((sum, item) => sum + (item.gatewayReportedCostUsd ?? 0), 0)),
      confirmedCostUsd: money(matched.reduce((sum, item) => sum + item.confirmedCostUsd, 0)),
    },
  })
}
