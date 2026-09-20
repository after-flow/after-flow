import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { INTERNAL_LIMITS, aiProposalSchema, eventSchema, heartbeatSchema, internalId, internalResultSchema, internalRoutes, requestMetadataSchema } from '@aftercare/internal-contracts'
import type { InternalScope } from '@aftercare/internal-contracts'
import type { InternalCall, InternalExecutionService } from '../../../../application/agent/internal-execution-service.js'
import type { ExecutionAuthorization } from '../../../../application/ports/execution-authorization.js'
import { matchesServiceCredential } from '../../../../infrastructure/identity/execution-authorization.js'
import { errors } from '../../../../shared/app-error.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import type { AppContext, AppEnv } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'

export function createExecutionApp(options: {
  service: InternalExecutionService; authorization: ExecutionAuthorization; serviceCredential: string
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const respond = (c: AppContext, route: keyof typeof internalRoutes, data: unknown) => {
    const parsed = internalRoutes[route].response.safeParse(data)
    if (!parsed.success) throw errors.internal({ internal: { reason: 'internal response contract mismatch', route } })
    return ok(c, parsed.data)
  }
  app.use('*', bodyLimit({ maxSize: INTERNAL_LIMITS.bodyBytes, onError: () => { throw errors.validationFailed({ details: { reason: 'BODY_TOO_LARGE' } }) } }))
  app.use('*', async (c, next) => {
    if (!matchesServiceCredential(c.req.header('Authorization') ?? '', `Bearer ${options.serviceCredential}`)) throw errors.unauthenticated()
    await next()
  })
  async function authorize(c: AppContext, scope: InternalScope, body: unknown): Promise<InternalCall> {
    const token = c.req.header('X-Execution-Authorization') ?? ''
    if (token.length > 4096) throw errors.unauthenticated()
    const claims = await options.authorization.verify(token)
    const runId = internalId.safeParse(c.req.param('runId'))
    if (!runId.success || runId.data !== claims.runId) throw errors.forbidden()
    const meta = requestMetadataSchema.safeParse({
      requestId: c.req.header('X-Request-Id'), jobId: c.req.header('X-Job-Id'), executionAttempt: c.req.header('X-Execution-Attempt'),
      issuedAt: Number(c.req.header('X-Issued-At')), expiresAt: Number(c.req.header('X-Expires-At')),
    })
    if (!meta.success) throw errors.validationFailed({ details: { reason: 'INVALID_INTERNAL_METADATA' } })
    return { claims, meta: meta.data, scope, fingerprint: fingerprintOf({ method: c.req.method, path: c.req.path, body }) }
  }
  async function readBody<T>(c: AppContext, schema: z.ZodType<T>) {
    let body: unknown
    try { body = await c.req.json() } catch { throw errors.validationFailed() }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw errors.validationFailed()
    return { raw: body, parsed: parsed.data }
  }
  app.get(internalRoutes.context.path, async c => respond(c, 'context', await options.service.context(await authorize(c, 'context', null))))
  app.get(internalRoutes.artifact.path, async c => {
    const id = internalId.safeParse(c.req.param('artifactId'))
    if (!id.success) throw errors.validationFailed()
    return respond(c, 'artifact', await options.service.artifact(await authorize(c, 'artifact', null), id.data))
  })
  app.get(internalRoutes.control.path, async c => respond(c, 'control', await options.service.control(await authorize(c, 'control', null))))
  app.post(internalRoutes.heartbeat.path, async c => {
    const body = await readBody(c, heartbeatSchema)
    const call = await authorize(c, 'heartbeat', body.raw)
    await options.service.heartbeat(call)
    return respond(c, 'heartbeat', { accepted: true, executionAuthorization: await options.authorization.issue(call.claims) })
  })
  app.post(internalRoutes.events.path, async c => {
    const body = await readBody(c, eventSchema)
    return respond(c, 'events', await options.service.event(await authorize(c, 'events', body.raw), body.parsed))
  })
  app.post(internalRoutes.result.path, async c => {
    const body = await readBody(c, internalResultSchema)
    return respond(c, 'result', await options.service.result(await authorize(c, 'result', body.raw), body.parsed))
  })
  app.post(internalRoutes.proposals.path, async c => {
    const body = await readBody(c, aiProposalSchema)
    return respond(c, 'proposals', await options.service.proposal(await authorize(c, 'proposals', body.raw), body.parsed))
  })
  return app
}
