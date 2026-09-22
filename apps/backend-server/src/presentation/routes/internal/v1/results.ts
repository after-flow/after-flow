import { Hono } from 'hono'
import { z } from 'zod'
import { guidanceCitationSchema, guidanceOutcomeSchema } from '@aftercare/internal-contracts'
import type { AgentResultIntake } from '../../../../application/chat/result-intake.js'
import { errors } from '../../../../shared/app-error.js'
import type { AppEnv } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import { idSchema, isoDateTimeSchema } from '../../../schemas/common.js'

/**
 * AI からの結果受領（内部 API）。
 *
 * 公開 API とは別の契約で、公開 OpenAPI には載せない。
 * ここは結果の受領だけを扱う。context / artifact / control / heartbeat /
 * events を含む内部 API の全体像は #36 が整備する。
 *
 * 現時点の認証は共有のサービストークンによる。Run ごとに scope を絞った
 * 資格情報への置き換えは #36 で行う。ネットワークの分離は配備側の責務。
 */
const sourceSchema = z.object({
  label: z.string().min(1).max(120),
  url: z.string().url().max(2000),
  checkedAt: isoDateTimeSchema,
})

const envelopeSchema = z.object({
  runId: idSchema,
  attemptId: z.string().min(1).max(200),
  resultId: z.string().min(1).max(200),
})

const guidanceResultSchema = envelopeSchema.extend({
  kind: z.literal('task_guidance'),
  status: z.enum(['COMPLETED', 'PARTIAL', 'FAILED', 'WAITING']),
  outcome: guidanceOutcomeSchema.optional(),
  target: z.string().max(200).nullish(),
  where: z.string().max(500).nullish(),
  bring: z.array(z.string().max(200)).max(50).default([]),
  steps: z.array(z.string().max(500)).max(50).default([]),
  formExampleUrl: z.string().url().max(2000).nullish(),
  formExampleLabel: z.string().max(120).nullish(),
  note: z.string().max(2000).nullish(),
  sources: z.array(sourceSchema).max(20).default([]),
  citations: z.array(guidanceCitationSchema).max(150).default([]),
  missing: z.array(z.string().max(200)).max(50).default([]),
  failureReason: z.string().max(500).nullish(),
})

const chatReplyResultSchema = envelopeSchema.extend({
  kind: z.literal('chat_reply'),
  body: z.string().min(1).max(10_000),
  professionalNotice: z.boolean().default(false),
})

const resultSchema = z.discriminatedUnion('kind', [guidanceResultSchema, chatReplyResultSchema])

const paramsSchema = z.object({ tenantId: idSchema, caseId: idSchema })

export interface InternalRouteOptions {
  intake: AgentResultIntake
  /** サービス間認証のトークン。未設定なら内部 API を有効にしない。 */
  serviceToken: string
  audience: string
}

export function createInternalApp(options: InternalRouteOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const authorization = c.req.header('Authorization')
    if (authorization !== `Bearer ${options.serviceToken}`) {
      throw errors.unauthenticated({ internal: { reason: 'invalid service token' } })
    }
    const audience = c.req.header('X-Audience')
    if (audience !== options.audience) {
      // 宛先違いの要求を受け付けない。
      throw errors.unauthenticated({ internal: { reason: 'audience mismatch' } })
    }
    await next()
  })

  app.post('/tenants/:tenantId/cases/:caseId/results', async (c) => {
    const params = paramsSchema.safeParse(c.req.param())
    if (!params.success) throw errors.validationFailed({ details: { source: 'params' } })

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch (cause) {
      throw errors.validationFailed({ message: 'JSON として解釈できませんでした。', cause })
    }

    const parsed = resultSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validationFailed({
        details: {
          source: 'body',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
          })),
        },
      })
    }

    const { tenantId, caseId } = params.data
    const outcome =
      parsed.data.kind === 'task_guidance'
        ? await options.intake.submitGuidanceResult(tenantId, caseId, parsed.data)
        : await options.intake.submitChatReply(tenantId, caseId, parsed.data)

    return ok(c, outcome)
  })

  return app
}
