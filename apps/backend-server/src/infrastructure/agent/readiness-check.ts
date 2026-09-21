import type { ReadinessCheck } from '../../application/operations/readiness-service.js'
import type { AgentClientConfig } from './http-agent-client.js'

const DEFAULT_TIMEOUT_MS = 3_000

/**
 * AI Serverへの認証付き疎通（liveness）を確認する。
 *
 * `AI操作が有効化されている場合だけ` 呼ばれる検査（#123 実装範囲）。
 * 確認できるのはAI ServerプロセスがHTTPへ応答することだけで、
 * Mastra/Orchの機能的な準備完了は保証しない（#123 対象外、architecture.md 6.3の
 * `/internal/v1/health/ready` はAI Server側の将来実装であり、現時点のAI Serverには無い）。
 */
export function createAiConnectivityReadinessCheck(
  config: AgentClientConfig,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): ReadinessCheck {
  return {
    name: 'ai_connectivity',
    async run() {
      let response: Response
      try {
        response = await fetch(`${config.baseUrl}/internal/v1/health`, {
          headers: { Authorization: `Bearer ${config.serviceToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        return { ok: false, reason: 'UNREACHABLE' }
      }
      if (!response.ok) return { ok: false, reason: `STATUS_${response.status}` }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'INVALID_RESPONSE' }
      }
      const service = (body as { data?: { service?: unknown } } | null)?.data?.service
      if (service !== 'ai-server') return { ok: false, reason: 'INVALID_RESPONSE' }
      return { ok: true }
    },
  }
}
