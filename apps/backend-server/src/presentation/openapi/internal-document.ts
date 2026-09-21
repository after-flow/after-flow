import { z } from 'zod'
import { dispatchAckSchema, dispatchSchema, cancelExecutionSchema, cancelExecutionAckSchema, INTERNAL_LIMITS, internalRoutes, snapshotStatusSchema } from '@aftercare/internal-contracts'

export function buildInternalOpenApiDocument() {
  const headers = [
    ['X-Request-Id', { type: 'string' }], ['X-Job-Id', { type: 'string' }],
    ['X-Execution-Attempt', { type: 'string' }], ['X-Issued-At', { type: 'integer' }], ['X-Expires-At', { type: 'integer' }],
  ].map(([name, schema]) => ({ in: 'header', name, required: true, schema }))
  const paths: Record<string, unknown> = {}
  for (const [name, route] of Object.entries(internalRoutes)) {
    const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: { type: 'string' } }))
    paths[route.path.replace(/:([A-Za-z]+)/g, '{$1}')] = { [route.method]: {
      operationId: `internal_${name}`, security: [{ serviceIdentity: [], executionAuthorization: [] }],
      parameters: [...params, ...headers],
      ...('body' in route ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(route.body, { io: 'input' }) } } } } : {}),
      responses: {
        '200': { description: 'Run scoped response', content: { 'application/json': { schema: {
          type: 'object', required: ['data', 'meta'], properties: { data: z.toJSONSchema(route.response), meta: {
            type: 'object', required: ['requestId'], properties: { requestId: { type: 'string' } },
          } },
        } } } },
        ...Object.fromEntries([400, 401, 403, 404, 409, 500, 503].map(code => [String(code), { description: 'InternalError', content: {
          'application/json': { schema: { $ref: '#/components/schemas/InternalError' } },
        } }])),
      },
    } }
  }
  paths['/runs/{runId}/dispatch'] = { post: {
    operationId: 'ai_dispatch', description: 'AI Server provider契約。Backendはこの契約で送信する。AI実装/ readiness完了の宣言ではない。',
    servers: [{ url: 'https://ai-server.internal/internal/v1' }], security: [{ serviceIdentity: [] }],
    parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'X-Audience', in: 'header', required: true, schema: { type: 'string', const: 'ai-server' } },
      { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(dispatchSchema) } } },
    responses: Object.fromEntries([200, 202, 409].map(code => [String(code), { description: code === 409 ? 'Verified duplicate only' : 'Accepted',
      content: { 'application/json': { schema: z.toJSONSchema(dispatchAckSchema) } } }])),
  } }
  paths['/runs/{runId}/resume'] = paths['/runs/{runId}/dispatch'] && {
    post: { ...(paths['/runs/{runId}/dispatch'] as { post: Record<string, unknown> }).post,
      operationId: 'ai_resume', description: '同一Jobの重複排除とfresh context取得後に再開する。Snapshot参照はcontext.resumeで取得。実AI接続は別途検証。' },
  }
  paths['/runs/{runId}/cancel'] = { post: {
    ...(paths['/runs/{runId}/dispatch'] as { post: Record<string, unknown> }).post,
    operationId: 'ai_cancel', description: 'Backendで取消済みのjob/attemptを停止する。未配送jobにも取消記録を保存する。',
    requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(cancelExecutionSchema) } } },
    responses: { '200': { description: 'Stopped or duplicate cancellation', content: { 'application/json': { schema: z.toJSONSchema(cancelExecutionAckSchema) } } } },
  } }
  paths['/runs/{runId}/snapshot-status'] = { get: {
    operationId: 'ai_snapshot_status', servers: [{ url: 'https://ai-server.internal/internal/v1' }], security: [{ serviceIdentity: [] }],
    description: 'runtime保存済みメタデータのみ。Snapshot本文は返さない。',
    parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
      ...['jobId', 'executionAttempt', 'waitRequestId'].map(name => ({ name, in: 'query', required: name !== 'waitRequestId', schema: { type: 'string' } })),
      { name: 'X-Audience', in: 'header', required: true, schema: { type: 'string', const: 'ai-server' } }],
    responses: { '200': { description: 'Saved runtime status', content: { 'application/json': { schema: z.toJSONSchema(snapshotStatusSchema) } } } },
  } }
  return { openapi: '3.1.0', info: { title: 'after-flow internal execution API', version: '1.0.0',
    description: `Request lifetime <= ${INTERNAL_LIMITS.requestSeconds}s; capability <= ${INTERNAL_LIMITS.authorizationSeconds}s; body <= ${INTERNAL_LIMITS.bodyBytes} bytes; client timeout <= ${INTERNAL_LIMITS.timeoutMs}ms. 429/5xx/transport errors retry; 409 requires explicit duplicate ACK. Credentials and business document bytes must not be logged.` },
    servers: [{ url: '/internal/v1' }], paths, components: {
      securitySchemes: { serviceIdentity: { type: 'http', scheme: 'bearer' }, executionAuthorization: { type: 'apiKey', in: 'header', name: 'X-Execution-Authorization' } },
      schemas: { InternalError: { type: 'object', required: ['error', 'meta'], properties: {
        error: { type: 'object', required: ['code', 'message', 'retryable'], properties: {
          code: { type: 'string', enum: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONSENT_REQUIRED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'PRECONDITION_FAILED', 'FEATURE_NOT_CONNECTED', 'INTERNAL'] },
          message: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object' },
        } }, meta: { type: 'object', properties: { requestId: { type: 'string' } } },
      } } },
    } }
}
