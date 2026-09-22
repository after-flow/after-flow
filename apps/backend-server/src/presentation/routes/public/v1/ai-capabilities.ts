import type { AiCapabilityService } from '../../../../application/agent/ai-capability-service.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { aiCapabilitiesResourceSchema } from '../../../schemas/ai-capability.js'
import { successEnvelope } from '../../../schemas/common.js'

export const aiCapabilitySpecs = {
  getAiCapabilities: {
    operationId: 'getAiCapabilities',
    method: 'get',
    path: '/ai/capabilities',
    summary: 'AI機能の接続可否',
    description:
      'Backend起動時に確定した接続済み業務操作（connectedOperations）から判定する。AI Serverへは問い合わせない。health結果・内部endpoint・provider名・model名は含めない。',
    tags: ['ai'],
    auth: 'user',
    success: {
      status: 200,
      description: '機能ごとの利用可否',
      schema: successEnvelope(aiCapabilitiesResourceSchema),
    },
    failures: ['UNAUTHENTICATED', 'FORBIDDEN', 'CONSENT_REQUIRED'],
  },
} satisfies Record<string, RouteSpec>

export function createAiCapabilityRoutes(service: AiCapabilityService): RegisteredRoute[] {
  return [
    defineRoute(aiCapabilitySpecs.getAiCapabilities, async (c) => ok(c, service.get())),
  ]
}
