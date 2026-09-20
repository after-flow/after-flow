import type { ApiErrorCode } from '@aftercare/public-contracts'
import type { Hono } from 'hono'
import { z } from 'zod'
import { errors } from '../../shared/app-error.js'
import type { AppContext, AppEnv } from './context.js'
import { ok } from './envelope.js'

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'

export interface RouteRequestSpec {
  params?: z.ZodObject
  query?: z.ZodObject
  body?: z.ZodType
}

export interface RouteResponseSpec {
  status: number
  description: string
  schema: z.ZodType
}

/**
 * route の定義。検証と OpenAPI 生成の両方がこの 1 箇所を読む。
 *
 * 契約と実装を別々に書くと、OpenAPI だけが合っている状態を「画面接続完了」と
 * 誤認する。定義を単一にして、生成物が実装からずれないようにする。
 */
export interface RouteSpec<Req extends RouteRequestSpec = RouteRequestSpec> {
  operationId: string
  method: HttpMethod
  /** Hono の path 表記（例: `/cases/:caseId`） */
  path: string
  summary: string
  description?: string
  tags: string[]
  /** `user` は認証必須。実際の検証 middleware は #6 が差し込む。 */
  auth: 'user' | 'public'
  request?: Req
  success: RouteResponseSpec
  /** 202 受付など、同じ route が返しうる別の成功応答 */
  alternateSuccess?: RouteResponseSpec[]
  /** この route が返しうる既知の失敗。OpenAPI と契約試験が参照する。 */
  failures: ApiErrorCode[]
  /** 状態を変える要求に Idempotency-Key を要求するか */
  idempotency?: 'required' | 'optional'
  /** body に expectedVersion を要求するか */
  expectedVersion?: 'required'
  /** 一覧応答。meta.nextCursor を返しうることを示す。 */
  list?: boolean
  /**
   * 必須同意の検査を適用するか。
   *
   * 既定は適用する。同意を取得するための API まで塞ぐと利用者が
   * 復旧できないため、それらだけ `exempt` にする。
   */
  consent?: 'exempt'
}

type InferOr<S, Fallback> = S extends z.ZodType ? z.infer<S> : Fallback

export interface HandlerInput<Req extends RouteRequestSpec> {
  params: InferOr<Req['params'], Record<string, never>>
  query: InferOr<Req['query'], Record<string, never>>
  body: InferOr<Req['body'], undefined>
  /** 冪等性キー。実際の重複排除は永続層（#5）が行う。 */
  idempotencyKey: string | null
}

export type RouteHandler<Req extends RouteRequestSpec> = (
  c: AppContext,
  input: HandlerInput<Req>,
) => Response | Promise<Response>

export interface RegisteredRoute {
  spec: RouteSpec
  handler: RouteHandler<RouteRequestSpec>
}

/** 型を保ったまま spec と handler を組にする。 */
export function defineRoute<Req extends RouteRequestSpec>(
  spec: RouteSpec<Req>,
  handler: RouteHandler<Req>,
): RegisteredRoute {
  return {
    spec: spec as RouteSpec,
    handler: handler as RouteHandler<RouteRequestSpec>,
  }
}

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
/** 実装の都合で長大なキーを受け入れると、保存側の制約と衝突する。 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

/**
 * Zod の issue から応答用の詳細を作る。
 *
 * `received` など入力そのものを含む項目は写さない。エラー応答に
 * 入力全文が載ると、個人情報がログや画面へ流れる経路になる。
 */
function toValidationDetails(source: 'params' | 'query' | 'body', error: z.ZodError) {
  return {
    source,
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  }
}

function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, source: 'params' | 'query' | 'body') {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw errors.validationFailed({ details: toValidationDetails(source, result.error) })
  }
  return result.data as z.infer<T>
}

/** query は同名複数指定を受けうる。配列を受ける schema だけが配列を見るようにする。 */
function collectQuery(c: AppContext): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of new URL(c.req.url).searchParams) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

async function readJsonBody(c: AppContext): Promise<unknown> {
  const contentType = c.req.header('Content-Type') ?? ''
  if (!/^application\/json\b/i.test(contentType)) {
    throw errors.unsupportedMediaType({
      message: 'Content-Type には application/json を指定してください。',
      details: { expected: 'application/json' },
    })
  }
  try {
    return await c.req.json()
  } catch (cause) {
    throw errors.validationFailed({ message: 'JSON として解釈できませんでした。', cause })
  }
}

function idempotencyKeyOf(c: AppContext, requirement: RouteSpec['idempotency']): string | null {
  const raw = c.req.header(IDEMPOTENCY_KEY_HEADER)
  if (raw === undefined || raw === '') {
    if (requirement === 'required') {
      throw errors.preconditionRequired({
        message: 'この操作には Idempotency-Key ヘッダーが必要です。',
        details: { header: IDEMPOTENCY_KEY_HEADER },
      })
    }
    return null
  }
  if (!IDEMPOTENCY_KEY.test(raw)) {
    throw errors.validationFailed({
      message: 'Idempotency-Key の形式が正しくありません。',
      details: { header: IDEMPOTENCY_KEY_HEADER },
    })
  }
  return raw
}

/**
 * expectedVersion の欠落は入力不正ではなく前提条件の不足として返す。
 *
 * 欠落を検証エラーに混ぜると、クライアントが「最新版で上書き」と
 * 誤った復旧をしやすい。428 で前提の不足だと明示する。
 */
function assertExpectedVersion(body: unknown, requirement: RouteSpec['expectedVersion']) {
  if (requirement !== 'required') return
  const present =
    typeof body === 'object' && body !== null && 'expectedVersion' in (body as Record<string, unknown>)
  if (!present) {
    throw errors.preconditionRequired({
      message: 'この更新には expectedVersion の指定が必要です。',
      details: { field: 'expectedVersion' },
    })
  }
}

export interface RegisterOptions {
  /**
   * 必須同意の検査。
   *
   * 未指定なら検査しない。同意機能が接続されていない環境で、
   * 検査を通ったことにしないよう、接続状況は組み立て側が判断する。
   */
  consentGate?: (c: AppContext) => Promise<void>
}

export function registerRoutes(
  app: Hono<AppEnv>,
  routes: RegisteredRoute[],
  options: RegisterOptions = {},
) {
  for (const { spec, handler } of routes) {
    app.on(spec.method.toUpperCase(), spec.path, async (c) => {
      // 認証が必要な route は、認証 middleware の有無に関係なくここで止める。
      // middleware の付け忘れが「誰でも通る API」にならないようにする。
      if (spec.auth === 'user' && !c.get('user')) throw errors.unauthenticated()

      // 必須同意の検査は入力検証より前に行う。未同意の利用者へ
      // 入力の不備を先に返しても、直しようがない。
      if (spec.consent !== 'exempt' && spec.auth === 'user' && options.consentGate) {
        await options.consentGate(c)
      }

      const request = spec.request ?? {}

      const params = request.params
        ? parseOrThrow(request.params, c.req.param() as Record<string, unknown>, 'params')
        : ({} as Record<string, never>)
      const query = request.query
        ? parseOrThrow(request.query, collectQuery(c), 'query')
        : ({} as Record<string, never>)

      const idempotencyKey = idempotencyKeyOf(c, spec.idempotency)

      let body: unknown
      if (request.body) {
        const raw = await readJsonBody(c)
        assertExpectedVersion(raw, spec.expectedVersion)
        body = parseOrThrow(request.body, raw, 'body')
      }

      return handler(c, {
        params,
        query,
        body,
        idempotencyKey,
      } as HandlerInput<RouteRequestSpec>)
    })
  }
}

export { ok }
