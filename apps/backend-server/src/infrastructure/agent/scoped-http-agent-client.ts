import { dispatchAckSchema, dispatchSchema, INTERNAL_LIMITS, internalId } from '@aftercare/internal-contracts'
import type { InternalExecutionService } from '../../application/agent/internal-execution-service.js'
import type { AgentDeliveryOutcome, AgentJob, AgentJobClient } from '../../application/ports/agent-client.js'
import type { ExecutionAuthorization } from '../../application/ports/execution-authorization.js'
import { AppError } from '../../shared/app-error.js'
import type { AgentClientConfig } from './http-agent-client.js'

/** 新内部契約だけを送信する。旧jobs endpointへのfallbackは禁止。 */
export class ScopedHttpAgentJobClient implements AgentJobClient {
  constructor(private readonly config: AgentClientConfig, private readonly service: InternalExecutionService,
    private readonly authorization: ExecutionAuthorization) {
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > INTERNAL_LIMITS.timeoutMs) throw new Error('Invalid internal HTTP timeout')
    const url = new URL(config.baseUrl)
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid AI URL')
  }
  async deliver(job: AgentJob): Promise<AgentDeliveryOutcome> {
    if (!job.type.startsWith('agent.') || !job.caseId || !internalId.safeParse(job.payload.runId).success) {
      return { status: 'RETRYABLE', reason: 'CONTROL_DELIVERY_NOT_CONNECTED' }
    }
    try {
      const claims = await this.service.dispatchClaims(job.tenantId, job.caseId, job.payload.runId as string, job.eventId)
      const issuedAt = Math.floor(Date.now() / 1000)
      const body = dispatchSchema.parse({ jobId: claims.jobId, runId: claims.runId, executionAttempt: claims.executionAttempt,
        operation: claims.operation, issuedAt, expiresAt: issuedAt + INTERNAL_LIMITS.requestSeconds,
        executionAuthorization: await this.authorization.issue(claims) })
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/internal/v1/runs/${claims.runId}/dispatch`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.serviceToken}`,
          'X-Audience': this.config.audience, 'X-Request-Id': job.eventId, 'Idempotency-Key': job.eventId }, body: JSON.stringify(body),
      })
      if ([200, 202, 409].includes(response.status)) {
        // 任意の409は成功ではない。応答本文のjobとrunと重複状態まで一致させる。
        const ack = dispatchAckSchema.safeParse(await readAck(response))
        if (ack.success && ack.data.jobId === claims.jobId && ack.data.runId === claims.runId
          && (response.status !== 409 || ack.data.status === 'DUPLICATE')) return { status: 'ACCEPTED' }
        return { status: 'RETRYABLE', reason: 'INVALID_DISPATCH_ACK' }
      }
      return response.status === 429 || response.status >= 500
        ? { status: 'RETRYABLE', reason: `status ${response.status}` }
        : { status: 'REJECTED', reason: `status ${response.status}` }
    } catch (cause) {
      if (cause instanceof AppError) return { status: 'RETRYABLE', reason: cause.code }
      return { status: 'RETRYABLE', reason: 'INTERNAL_TRANSPORT_ERROR' }
    }
  }
}

async function readAck(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 4096) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { reader.releaseLock() }
}
