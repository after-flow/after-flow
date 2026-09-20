import type { ApiErrorCode } from '@aftercare/public-contracts'
import { z } from 'zod'
import { ERROR_STATUS } from '../../shared/app-error.js'
import type { RouteResponseSpec, RouteSpec } from '../http/route.js'
import { REQUEST_ID_HEADER } from '../http/request-id.js'
import { apiFailureSchema } from '../schemas/common.js'

type JsonSchema = Record<string, unknown>

/** Hono の `:param` 表記を OpenAPI の `{param}` 表記へ変換する。 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    // 表現できない型を無言で any にせず、生成時に失敗させる。
    unrepresentable: 'throw',
  }) as JsonSchema
}

function propertiesOf(schema: z.ZodObject, io: 'input' | 'output') {
  const json = jsonSchemaOf(schema, io)
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((json.required ?? []) as string[])
  return { properties, required }
}

function parametersOf(spec: RouteSpec) {
  const parameters: JsonSchema[] = []
  const request = spec.request ?? {}

  if (request.params) {
    const { properties, required } = propertiesOf(request.params, 'input')
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({
        name,
        in: 'path',
        // path パラメーターは OpenAPI 上つねに必須。
        required: true,
        schema,
      })
    }
    void required
  }

  if (request.query) {
    const { properties, required } = propertiesOf(request.query, 'input')
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({ name, in: 'query', required: required.has(name), schema })
    }
  }

  if (spec.idempotency) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: spec.idempotency === 'required',
      description:
        '同じ操作の再送を重複適用しないためのキー。同じキーで異なる内容を送ると IDEMPOTENCY_KEY_REUSED になる。',
      schema: { type: 'string', minLength: 8, maxLength: 200 },
    })
  }

  parameters.push({
    name: REQUEST_ID_HEADER,
    in: 'header',
    required: false,
    description: '指定すると応答の meta.requestId に引き継ぐ。安全な字種・長さでない場合はサーバーが採番する。',
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  })

  return parameters
}

function successResponse(response: RouteResponseSpec) {
  return [
    String(response.status),
    {
      description: response.description,
      content: { 'application/json': { schema: jsonSchemaOf(response.schema, 'output') } },
    },
  ] as const
}

/**
 * 失敗応答を status ごとにまとめる。
 *
 * 同じ status に複数のコードが対応するため（409 は CONFLICT と
 * IDEMPOTENCY_KEY_REUSED と PRECONDITION_FAILED）、description に
 * どのコードが返りうるかを列挙する。
 */
function failureResponses(failures: ApiErrorCode[]) {
  const byStatus = new Map<number, ApiErrorCode[]>()
  // 予期しない例外はすべての route が返しうる。
  const codes = failures.includes('INTERNAL') ? failures : [...failures, 'INTERNAL' as const]
  for (const code of codes) {
    const status = ERROR_STATUS[code]
    byStatus.set(status, [...(byStatus.get(status) ?? []), code])
  }
  return [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, statusCodes]) => [
      String(status),
      {
        description: `error.code: ${statusCodes.join(' / ')}`,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiFailure' } } },
      },
    ])
}

function operationOf(spec: RouteSpec) {
  const request = spec.request ?? {}
  return {
    operationId: spec.operationId,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    security: spec.auth === 'user' ? [{ bearerAuth: [] }] : [],
    parameters: parametersOf(spec),
    ...(request.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchemaOf(request.body, 'input') } },
          },
        }
      : {}),
    responses: Object.fromEntries([
      successResponse(spec.success),
      ...(spec.alternateSuccess ?? []).map(successResponse),
      ...failureResponses(spec.failures),
    ]),
  }
}

export interface OpenApiOptions {
  version: string
  basePath: string
}

/**
 * 公開 route の定義から OpenAPI 文書を組み立てる。
 *
 * 手書きの定義ファイルを別に持つと、実装と契約が静かにずれる。
 * 生成物は CI で再生成して差分が無いことを検証する。
 */
export function buildOpenApiDocument(specs: RouteSpec[], options: OpenApiOptions) {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const spec of specs) {
    const path = toOpenApiPath(spec.path)
    paths[path] ??= {}
    if (paths[path][spec.method]) {
      throw new Error(`duplicate route: ${spec.method.toUpperCase()} ${path}`)
    }
    paths[path][spec.method] = operationOf(spec)
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'after-flow 公開 API',
      version: options.version,
      description:
        'Web からの業務通信はこの公開 API のみを経由する。成功は { data, meta }、失敗は { error, meta } を返し、いずれも meta.requestId を含む。',
    },
    servers: [{ url: options.basePath }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ApiFailure: jsonSchemaOf(apiFailureSchema, 'output'),
      },
    },
    paths,
  }
}
