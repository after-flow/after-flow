import { z } from 'zod'
import type { InsightService } from '../../../../application/insights/insight-service.js'
import { ok } from '../../../http/envelope.js'
import { defineRoute, type RegisteredRoute, type RouteSpec } from '../../../http/route.js'
import { idSchema, successEnvelope } from '../../../schemas/common.js'
import { businessListQuerySchema, insightResourceSchema } from '../../../schemas/business.js'
import { businessContext } from './business-context.js'
const acknowledgeSchema = z.object({ note: z.string().max(2000).optional() }).strict()
const dismissSchema = z.object({ reason: z.string().max(2000).optional() }).strict()

export const insightsSpecs = {
  listInsights: {
    operationId: 'listInsights', method: 'get', path: '/cases/:caseId/insights',
    summary: 'listInsights', tags: ['insights'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Insight', schema: successEnvelope(z.array(insightResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  acknowledge: {
    operationId: 'acknowledge', method: 'post', path: '/cases/:caseId/insights/:insightId/acknowledge',
    summary: 'acknowledge', tags: ['insights'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, insightId: idSchema }), body: acknowledgeSchema },
    success: { status: 200, description: 'Insight', schema: successEnvelope(insightResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  dismiss: {
    operationId: 'dismiss', method: 'post', path: '/cases/:caseId/insights/:insightId/dismiss',
    summary: 'dismiss', tags: ['insights'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, insightId: idSchema }), body: dismissSchema },
    success: { status: 200, description: 'Insight', schema: successEnvelope(insightResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
} satisfies Record<string, RouteSpec>

export function createInsightRoutes(service: InsightService): RegisteredRoute[] {
  return [
    defineRoute(insightsSpecs.listInsights, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listInsights(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(insightsSpecs.acknowledge, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.acknowledge(ctx, input.params.insightId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(insightsSpecs.dismiss, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.dismiss(ctx, input.params.insightId, input.body)
      return ok(c, result.body)
    }),
  ]
}
