import type { AiCapabilitiesResource, AiFeatureCapabilityResource, AiFeatureResource } from '@aftercare/public-contracts'
import type { AgentOperation } from '../../domain/agent/agent-run.js'

/** Frontend向け機能名からBackend内部operationへの対応。抽象レイヤーを混同しない。 */
const FEATURE_OPERATIONS = {
  task_guidance: 'task_guidance',
  ai_chat: 'chat_reply',
} as const satisfies Record<AiFeatureResource, AgentOperation>

/**
 * AI機能の接続可否をFrontendへ公開する（Issue #215）。
 *
 * 正本は `composition.ts` の `connectedOperations(env)` のみ。AI Server へは
 * 問い合わせない。ここでは受け取った集合を公開用の形へ変換するだけ。
 */
export class AiCapabilityService {
  constructor(private readonly connectedOperations: ReadonlySet<AgentOperation>) {}

  get(): AiCapabilitiesResource {
    return {
      features: {
        task_guidance: this.capabilityOf('task_guidance'),
        ai_chat: this.capabilityOf('ai_chat'),
      },
    }
  }

  private capabilityOf(feature: AiFeatureResource): AiFeatureCapabilityResource {
    return this.connectedOperations.has(FEATURE_OPERATIONS[feature])
      ? { available: true, reason: null }
      : { available: false, reason: 'FEATURE_NOT_CONNECTED' }
  }
}
