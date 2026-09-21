import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { dispatchSchema, cancelExecutionSchema, INTERNAL_LIMITS, internalId, snapshotStatusSchema } from '@aftercare/internal-contracts'
import type { ExecutionRuntime } from '../../../../application/ports/execution-runtime.js'

export interface ExecutionOptions {
  serviceToken?: string
  audience?: string
  runtime?: ExecutionRuntime
}
const digest = (value: string) => createHash('sha256').update(value).digest()
const snapshotQuerySchema = z.object({
  jobId: internalId, executionAttempt: internalId, waitRequestId: internalId.nullable(),
}).strict()

export function executionRoutes(options: ExecutionOptions) {
  const app = new Hono()
  const unavailable = { error: { code: 'AI_EXECUTION_NOT_CONNECTED' } }
  app.use('*', async (c, next) => {
    if (!options.serviceToken?.trim()) return c.json(unavailable, 503)
    if (!timingSafeEqual(digest(c.req.header('Authorization') ?? ''), digest(`Bearer ${options.serviceToken}`)) ||
        c.req.header('X-Audience') !== (options.audience ?? 'ai-server')) {
      return c.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    }
    await next()
  })
  app.use('*', bodyLimit({ maxSize: INTERNAL_LIMITS.bodyBytes, onError: c => c.json({ error: { code: 'BODY_TOO_LARGE' } }, 413) }))
  app.onError(() => new Response(JSON.stringify(unavailable), { status: 503, headers: { 'Content-Type': 'application/json' } }))

  for (const kind of ['dispatch', 'resume'] as const) {
    app.post(`/runs/:runId/${kind}`, async c => {
      const requestId = internalId.safeParse(c.req.header('X-Request-Id'))
      const raw: unknown = await c.req.json().catch(() => null)
      const input = dispatchSchema.safeParse(raw)
      const now = Math.floor(Date.now() / 1000)
      if (!requestId.success || !input.success || input.data.runId !== c.req.param('runId') ||
          c.req.header('Idempotency-Key') !== input.data.jobId || requestId.data !== input.data.jobId ||
          input.data.issuedAt > now || input.data.expiresAt <= now || input.data.expiresAt <= input.data.issuedAt ||
          input.data.expiresAt - input.data.issuedAt > INTERNAL_LIMITS.requestSeconds) {
        return c.json({ error: { code: 'INVALID_DISPATCH' } }, 400)
      }
      if (!options.runtime) return c.json(unavailable, 503)
      const status = await options.runtime.accept(input.data, kind)
      if (status !== 'ACCEPTED' && status !== 'DUPLICATE') return c.json(unavailable, 503)
      return c.json({ jobId: input.data.jobId, runId: input.data.runId, status }, status === 'ACCEPTED' ? 202 : 200)
    })
  }
  app.post('/runs/:runId/cancel', async c => {
    const input = cancelExecutionSchema.safeParse(await c.req.json().catch(() => null))
    const now = Math.floor(Date.now() / 1000)
    if (!input.success || input.data.runId !== c.req.param('runId') || c.req.header('X-Request-Id') !== input.data.cancelId ||
      c.req.header('Idempotency-Key') !== input.data.cancelId || input.data.issuedAt > now || input.data.expiresAt <= now ||
      input.data.expiresAt <= input.data.issuedAt || input.data.expiresAt - input.data.issuedAt > INTERNAL_LIMITS.requestSeconds) return c.json({ error: { code: 'INVALID_CANCEL' } }, 400)
    if (!options.runtime?.cancel) return c.json(unavailable, 503)
    const { cancelId, runId, jobId, executionAttempt } = input.data
    const status = await options.runtime.cancel(input.data)
    return c.json({ cancelId, runId, jobId, executionAttempt, status }, 200)
  })
  app.get('/runs/:runId/snapshot-status', async c => {
    const runId = internalId.safeParse(c.req.param('runId'))
    const input = snapshotQuerySchema.safeParse({ ...c.req.query(), waitRequestId: c.req.query('waitRequestId') ?? null })
    if (!runId.success || !input.success) return c.json({ error: { code: 'INVALID_SNAPSHOT_QUERY' } }, 400)
    if (!options.runtime) return c.json(unavailable, 503)
    const scope = { runId: runId.data, ...input.data }
    const result = snapshotStatusSchema.parse(await options.runtime.snapshot(scope))
    if (result.runId !== scope.runId || result.jobId !== scope.jobId || result.executionAttempt !== scope.executionAttempt || result.waitRequestId !== scope.waitRequestId) {
      return c.json(unavailable, 503)
    }
    return c.json(result)
  })
  return app
}
