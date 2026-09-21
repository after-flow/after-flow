import { dispatchAckSchema, dispatchSchema, cancelExecutionSchema, cancelExecutionAckSchema, INTERNAL_LIMITS, internalId, snapshotStatusSchema } from '@aftercare/internal-contracts'
import type { ExecutionSnapshots } from '../../application/ports/execution-snapshots.js'
import type { InternalExecutionService } from '../../application/agent/internal-execution-service.js'
import type { AgentDeliveryOutcome, AgentJob, AgentJobClient } from '../../application/ports/agent-client.js'
import type { ExecutionAuthorization } from '../../application/ports/execution-authorization.js'
import { AppError } from '../../shared/app-error.js'
import type { AgentClientConfig } from './http-agent-client.js'

/** 新内部契約だけを送信する。旧jobs endpointへのfallbackは禁止。 */
export class ScopedHttpAgentJobClient implements AgentJobClient, ExecutionSnapshots {
  constructor(private readonly config: AgentClientConfig, private readonly service: InternalExecutionService,
    private readonly authorization: ExecutionAuthorization) {
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > INTERNAL_LIMITS.timeoutMs) throw new Error('Invalid internal HTTP timeout')
    const url = new URL(config.baseUrl)
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid AI URL')
  }
  async deliver(job: AgentJob): Promise<AgentDeliveryOutcome> {
    if (!job.type.startsWith('agent.')) return { status: 'REJECTED', reason: 'NO_CONSUMER' }
    if (!job.caseId || !internalId.safeParse(job.payload.runId).success) return { status: 'REJECTED', reason: 'INVALID_AGENT_JOB' }
    try {
      if (job.type === 'agent.cancel') return await this.cancel(job)
      const runId = job.payload.runId as string
      if (await this.service.deliverySettled(job.tenantId, job.caseId, runId, job.eventId)) return { status: 'ACCEPTED' }
      const claims = await this.service.dispatchClaims(job.tenantId, job.caseId, runId, job.eventId)
      const issuedAt = Math.floor(Date.now() / 1000)
      const body = dispatchSchema.parse({ jobId: claims.jobId, runId: claims.runId, executionAttempt: claims.executionAttempt,
        operation: claims.operation, issuedAt, expiresAt: issuedAt + INTERNAL_LIMITS.requestSeconds,
        executionAuthorization: await this.authorization.issue(claims) })
      const endpoint = job.type === 'agent.resume' || job.type === 'agent.recover' ? 'resume' : 'dispatch'
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/internal/v1/runs/${claims.runId}/${endpoint}`, {
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
      if (response.status === 429 || response.status >= 500) {
        // AI未接続はステータス設定であり時間をおいても変わらない。一時障害と区別して即時REJECTEDにする。
        let code: unknown
        try { code = (await readAck(response) as { error?: { code?: unknown } } | null)?.error?.code } catch { code = undefined }
        if (code === 'AI_EXECUTION_NOT_CONNECTED') return { status: 'REJECTED', reason: code }
        return { status: 'RETRYABLE', reason: `status ${response.status}` }
      }
      return { status: 'REJECTED', reason: `status ${response.status}` }
    } catch (cause) {
      if (cause instanceof AppError) return { status: 'RETRYABLE', reason: cause.code }
      return { status: 'RETRYABLE', reason: 'INTERNAL_TRANSPORT_ERROR' }
    }
  }

  private async cancel(job: AgentJob): Promise<AgentDeliveryOutcome> {
    const identity = await this.service.cancellation(job.tenantId, job.caseId!, job.payload.runId as string, job.eventId)
    const issuedAt = Math.floor(Date.now() / 1000)
    const body = cancelExecutionSchema.parse({ ...identity, issuedAt, expiresAt: issuedAt + INTERNAL_LIMITS.requestSeconds })
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/internal/v1/runs/${identity.runId}/cancel`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.serviceToken}`,
        'X-Audience': this.config.audience, 'X-Request-Id': job.eventId, 'Idempotency-Key': job.eventId }, body: JSON.stringify(body),
    })
    if (response.status === 200) {
      const ack = cancelExecutionAckSchema.safeParse(await readAck(response))
      if (ack.success && ack.data.cancelId === identity.cancelId && ack.data.runId === identity.runId &&
        ack.data.jobId === identity.jobId && ack.data.executionAttempt === identity.executionAttempt) return { status: 'ACCEPTED' }
      return { status: 'RETRYABLE', reason: 'INVALID_CANCEL_ACK' }
    }
    await response.body?.cancel()
    return response.status === 429 || response.status >= 500 ? { status: 'RETRYABLE', reason: `status ${response.status}` } : { status: 'REJECTED', reason: `status ${response.status}` }
  }

  async status(input: Parameters<ExecutionSnapshots['status']>[0]) {
    for (const id of [input.runId, input.jobId, input.executionAttempt, ...(input.waitRequestId ? [input.waitRequestId] : [])]) internalId.parse(id)
    const query = new URLSearchParams({ jobId: input.jobId, executionAttempt: input.executionAttempt,
      ...(input.waitRequestId ? { waitRequestId: input.waitRequestId } : {}) })
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/internal/v1/runs/${input.runId}/snapshot-status?${query}`, {
      redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { Authorization: `Bearer ${this.config.serviceToken}`, 'X-Audience': this.config.audience },
    })
    if (response.status !== 200) throw new Error('Snapshot status unavailable')
    return snapshotStatusSchema.parse(await readAck(response))
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
