import type {
  AgentDeliveryOutcome,
  AgentJob,
  AgentJobClient,
} from '../../application/ports/agent-client.js'

/**
 * AI Server への配送（HTTP）。
 *
 * Backend と AI は独立したサービスで、相手の src を import しない。
 * 資格情報は Backend 側だけが持ち、AI へ業務 Firestore の設定は渡さない。
 */
export interface AgentClientConfig {
  baseUrl: string
  /** サービス間認証のトークン。要求ごとに付与する。 */
  serviceToken: string
  /** 送信の待ち時間。超えたら一時障害として扱う。 */
  timeoutMs: number
  /** 受信側が検証する audience。 */
  audience: string
}

export class HttpAgentJobClient implements AgentJobClient {
  constructor(private readonly config: AgentClientConfig) {}

  async deliver(job: AgentJob): Promise<AgentDeliveryOutcome> {
    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}/internal/v1/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.serviceToken}`,
          // 受信側が宛先違いの配送を拒否できるようにする。
          'X-Audience': this.config.audience,
          // 重複排除のキー。同じ値の再配送は受信側が弾く。
          'Idempotency-Key': job.eventId,
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (cause) {
      // 送信できたかどうか分からない。成功扱いにせず再送させる。
      return { status: 'RETRYABLE', reason: `transport error: ${describe(cause)}` }
    }

    if (response.status === 200 || response.status === 202 || response.status === 409) {
      // 409 は受信側が重複として弾いた場合。配送そのものは成立している。
      return { status: 'ACCEPTED' }
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: 'RETRYABLE', reason: `status ${response.status}` }
    }
    return { status: 'REJECTED', reason: `status ${response.status}` }
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.name
  return 'unknown'
}

export function readAgentClientConfig(env: NodeJS.ProcessEnv = process.env): AgentClientConfig | null {
  // 設定が無ければ配送しない。接続済みのふりをしない。
  if (!env.AI_SERVER_URL || !env.AI_SERVICE_TOKEN) return null
  return {
    baseUrl: env.AI_SERVER_URL,
    serviceToken: env.AI_SERVICE_TOKEN,
    timeoutMs: Number(env.AI_SERVICE_TIMEOUT_MS ?? 10_000),
    audience: env.AI_SERVICE_AUDIENCE ?? 'ai-server',
  }
}
