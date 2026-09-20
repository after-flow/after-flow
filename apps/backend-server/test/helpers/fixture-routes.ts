import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { AppEnv } from '../../src/presentation/http/context.js'
import { defineRoute, ok } from '../../src/presentation/http/route.js'
import { successEnvelope, caseIdParamSchema, expectedVersionSchema, listQuerySchema } from '../../src/presentation/schemas/common.js'
import { errors } from '../../src/shared/app-error.js'

/**
 * 基盤の試験だけに使う route。
 *
 * 公開 API の実装ではないので src には置かない。共通の検証・エラー契約を
 * 本番 route の有無に依存せず確かめるために用意している。
 */

const echoSchema = z.object({
  caseId: z.string(),
  limit: z.number(),
  cursor: z.string().optional(),
  note: z.string().optional(),
  idempotencyKey: z.string().nullable(),
})

export const listFixtureRoute = defineRoute(
  {
    operationId: 'fixtureList',
    method: 'get',
    path: '/cases/:caseId/fixtures',
    summary: 'fixture 一覧',
    tags: ['fixture'],
    auth: 'user',
    request: { params: caseIdParamSchema, query: listQuerySchema },
    success: { status: 200, description: 'ok', schema: successEnvelope(echoSchema) },
    failures: ['VALIDATION_FAILED', 'NOT_FOUND'],
    list: true,
  },
  (c, input) =>
    ok(
      c,
      {
        caseId: input.params.caseId,
        limit: input.query.limit,
        cursor: input.query.cursor,
        idempotencyKey: input.idempotencyKey,
      },
      { nextCursor: 'bmV4dA' },
    ),
)

const createBodySchema = z.object({
  note: z.string().min(1).max(100),
})

export const createFixtureRoute = defineRoute(
  {
    operationId: 'fixtureCreate',
    method: 'post',
    path: '/cases/:caseId/fixtures',
    summary: 'fixture 作成',
    tags: ['fixture'],
    auth: 'user',
    request: { params: caseIdParamSchema, body: createBodySchema },
    success: { status: 200, description: 'ok', schema: successEnvelope(echoSchema) },
    failures: ['VALIDATION_FAILED', 'PRECONDITION_REQUIRED', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  (c, input) =>
    ok(c, {
      caseId: input.params.caseId,
      limit: 0,
      note: input.body.note,
      idempotencyKey: input.idempotencyKey,
    }),
)

const patchBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  note: z.string().min(1).optional(),
})

export const patchFixtureRoute = defineRoute(
  {
    operationId: 'fixturePatch',
    method: 'patch',
    path: '/cases/:caseId/fixtures/:fixtureId',
    summary: 'fixture 更新',
    tags: ['fixture'],
    auth: 'user',
    request: {
      params: caseIdParamSchema.extend({ fixtureId: z.string().min(1) }),
      body: patchBodySchema,
    },
    success: { status: 200, description: 'ok', schema: successEnvelope(echoSchema) },
    failures: ['VALIDATION_FAILED', 'PRECONDITION_REQUIRED', 'CONFLICT'],
    expectedVersion: 'required',
  },
  (c, input) =>
    ok(c, {
      caseId: input.params.caseId,
      limit: input.body.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    }),
)

/** Application 層が既知エラーを投げた場合の写り方を確かめる。 */
export const knownFailureRoute = defineRoute(
  {
    operationId: 'fixtureKnownFailure',
    method: 'get',
    path: '/fixtures/known-failure',
    summary: '既知エラー',
    tags: ['fixture'],
    auth: 'user',
    success: { status: 200, description: 'ok', schema: successEnvelope(z.object({})) },
    failures: ['CONFLICT'],
  },
  () => {
    throw errors.conflict({
      details: { expectedVersion: 3, actualVersion: 5 },
      internal: { secretHint: 'must-not-be-returned' },
    })
  },
)

/** 予期しない例外が契約どおりに畳まれ、内部情報が漏れないことを確かめる。 */
export const unexpectedFailureRoute = defineRoute(
  {
    operationId: 'fixtureUnexpectedFailure',
    method: 'get',
    path: '/fixtures/unexpected-failure',
    summary: '予期しない例外',
    tags: ['fixture'],
    auth: 'user',
    success: { status: 200, description: 'ok', schema: successEnvelope(z.object({})) },
    failures: ['INTERNAL'],
  },
  () => {
    throw new Error('internal detail: connection string postgres://user:pw@host')
  },
)

export const fixtureRoutes = [
  listFixtureRoute,
  createFixtureRoute,
  patchFixtureRoute,
  knownFailureRoute,
  unexpectedFailureRoute,
]

/**
 * 基盤試験用の認証済み状態。
 *
 * 認証の検証そのものは authentication.test.ts が実 Adapter で行う。
 * ここでは「認証済みなら共通契約がどう動くか」だけを見る。
 */
export const stubAuthentication = createMiddleware<AppEnv>(async (c, next) => {
  c.set('user', { userId: 'user-test-0001', tenantId: 'tenant-test' })
  await next()
})
