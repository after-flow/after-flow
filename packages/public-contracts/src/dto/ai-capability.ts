/**
 * Frontend向けのAI機能名と、機能ごとの利用可否。
 *
 * Backend内部の operation（`AgentOperationResource` の `chat_reply` 等）は
 * そのまま公開しない。Frontend が知るのは利用者向けの機能名だけにする。
 */
export type AiFeatureResource = 'task_guidance' | 'ai_chat'

/** 矛盾した状態（available:true かつ reason 有り、等）を型で作れないようにする。 */
export type AiFeatureCapabilityResource =
  | {
      available: true
      reason: null
    }
  | {
      available: false
      reason: 'FEATURE_NOT_CONNECTED'
    }

export interface AiCapabilitiesResource {
  features: {
    task_guidance: AiFeatureCapabilityResource
    ai_chat: AiFeatureCapabilityResource
  }
}
