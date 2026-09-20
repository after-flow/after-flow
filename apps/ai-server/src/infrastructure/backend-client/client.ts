import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { dispatchSchema, INTERNAL_LIMITS, internalId, internalRoutes } from '@aftercare/internal-contracts'
import type { AiProposalInput, InternalResult, ProgressEvent, RunDispatch, WaitRequestInput } from '@aftercare/internal-contracts'

type Route = keyof typeof internalRoutes
type ResponseOf<K extends Route> = z.infer<(typeof internalRoutes)[K]['response']>
export class BackendCallError extends Error {
  constructor(readonly code: 'TRANSPORT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE', readonly status?: number) {
    super(`Backend internal request failed: ${code}`)
    this.name = 'BackendCallError'
  }
}
export interface BackendClientConfig {
  baseUrl: string
  serviceToken: string
  audience?: string
  timeoutMs?: number
  /** Local development only: requires an exact hostname allowlist as well. */
  allowInsecureHttp?: boolean
  insecureHttpAllowedHosts?: readonly string[]
}

/** One capability-bound client per execution attempt. Never place it in model context. */
export class BackendClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly dispatch: RunDispatch
  private authorization: string
  private readonly config: Readonly<BackendClientConfig>

  constructor(config: BackendClientConfig, dispatch: RunDispatch) {
    const url = new URL(config.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('Backend URL must be an HTTP(S) origin')
    }
    if (url.protocol === 'http:' && (config.allowInsecureHttp !== true || !config.insecureHttpAllowedHosts?.includes(url.hostname))) {
      throw new Error('Backend requires HTTPS unless HTTP and the exact hostname are explicitly allowed')
    }
    if (!config.serviceToken.trim() || /[\r\n]/.test(config.serviceToken)) throw new Error('Backend service credential is required')
    this.config = Object.freeze({ ...config })
    this.baseUrl = url.origin
    this.timeoutMs = config.timeoutMs ?? INTERNAL_LIMITS.timeoutMs
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > INTERNAL_LIMITS.timeoutMs) throw new Error('Invalid Backend timeout')
    this.dispatch = dispatchSchema.parse(dispatch)
    this.authorization = this.dispatch.executionAuthorization
  }

  context(options?: CallOptions) { return this.call('context', undefined, undefined, options) }
  artifact(artifactId: string, options?: CallOptions) { return this.call('artifact', undefined, internalId.parse(artifactId), options) }
  control(options?: CallOptions) { return this.call('control', undefined, undefined, options) }
  async heartbeat(options?: CallOptions) {
    const result = await this.call('heartbeat', {}, undefined, options)
    if (!result.executionAuthorization || result.executionAuthorization.length > 4096 || /[\r\n]/.test(result.executionAuthorization)) {
      throw new BackendCallError('INVALID_RESPONSE')
    }
    this.authorization = result.executionAuthorization
    return { accepted: result.accepted }
  }
  event(event: ProgressEvent, options?: CallOptions) { return this.call('events', event, undefined, options) }
  result(result: InternalResult, options?: CallOptions) { return this.call('result', result, undefined, options) }
  propose(proposal: AiProposalInput, options?: CallOptions) { return this.call('proposals', proposal, undefined, options) }
  wait(input: WaitRequestInput, options?: CallOptions) { return this.call('wait-requests', input, undefined, options) }

  private async call<K extends Route>(route: K, input?: unknown, artifactId?: string, options: CallOptions = {}): Promise<ResponseOf<K>> {
    options.signal?.throwIfAborted()
    const contract = internalRoutes[route]
    const body = 'body' in contract ? JSON.stringify(contract.body.parse(input)) : undefined
    if (body && Buffer.byteLength(body) > INTERNAL_LIMITS.bodyBytes) throw new Error('Internal request body too large')
    const requestId = internalId.parse(options.requestId ?? randomUUID())
    const issuedAt = Math.floor(Date.now() / 1000)
    const path = contract.path.replace(':runId', this.dispatch.runId).replace(':artifactId', artifactId ?? '')
    let response: Response
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    try {
      response = await fetch(`${this.baseUrl}/internal/v1${path}`, {
        method: contract.method.toUpperCase(), redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${this.config.serviceToken}`, 'X-Audience': this.config.audience ?? 'backend-internal',
          'X-Execution-Authorization': this.authorization, 'X-Request-Id': requestId,
          'X-Job-Id': this.dispatch.jobId, 'X-Execution-Attempt': this.dispatch.executionAttempt,
          'X-Issued-At': String(issuedAt), 'X-Expires-At': String(issuedAt + INTERNAL_LIMITS.requestSeconds),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        }, body,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new BackendCallError('HTTP_ERROR', response.status)
      }
      const parsed = z.object({ data: contract.response }).safeParse(await readBoundedJson(response))
      if (!parsed.success) throw new BackendCallError('INVALID_RESPONSE')
      return parsed.data.data as ResponseOf<K>
    } catch (error) {
      if (error instanceof BackendCallError) throw error
      if (options.signal?.aborted) options.signal.throwIfAborted()
      // Provider errors can contain credentials/URLs/body; never expose the original cause.
      throw new BackendCallError('TRANSPORT')
    }
  }
}

export interface CallOptions { requestId?: string; signal?: AbortSignal }

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new BackendCallError('INVALID_RESPONSE')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > INTERNAL_LIMITS.bodyBytes + 4096) {
        await reader.cancel()
        throw new BackendCallError('RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new BackendCallError('INVALID_RESPONSE') }
  } finally { reader.releaseLock() }
}
