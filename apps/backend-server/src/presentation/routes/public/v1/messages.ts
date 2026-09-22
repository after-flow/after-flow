import { z } from 'zod'
import type { MessageService } from '../../../../application/chat/message-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { accepted, ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import {
  guidanceResourceSchema,
  messageAcceptedResourceSchema,
  messageResourceSchema,
  postMessageBodySchema,
  taskGuidanceParamsSchema,
} from '../../../schemas/chat.js'
import { listQuerySchema, successEnvelope } from '../../../schemas/common.js'

const messageListEnvelope = successEnvelope(z.array(messageResourceSchema))
const messageAcceptedEnvelope = successEnvelope(messageAcceptedResourceSchema)
const guidanceEnvelope = successEnvelope(guidanceResourceSchema)

const COMMON_FAILURES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONSENT_REQUIRED',
] as const

export const messageSpecs = {
  listMessages: {
    operationId: 'listMessages',
    method: 'get',
    path: '/cases/:caseId/messages',
    summary: 'チャットの履歴',
    description: '利用者の発言とAIの回答を区別して返す。',
    tags: ['chat'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '発言の一覧', schema: messageListEnvelope },
    failures: [...COMMON_FAILURES],
    list: true,
  },
  postMessage: {
    operationId: 'postMessage',
    method: 'post',
    path: '/cases/:caseId/messages',
    summary: '発言して回答を依頼する',
    description:
      '202で受け付ける。回答は後から履歴の取得で確認する。回答の実行を接続未了で受け付けられない場合も発言は残し、reason:FEATURE_NOT_CONNECTEDを返す。外部AI事業者への提供同意（CROSS_BORDER_AI）が無い、または版が古い場合は発言を保存する前に403 CONSENT_REQUIRED（details.requiredConsent）で拒否する。ただし保存後・実行の受付前に同意が撤回された競合時は、発言は保存済みのまま403 CONSENT_REQUIREDになりうる（202には丸めない）。',
    tags: ['chat'],
    auth: 'user',
    request: { params: caseIdParamsSchema, body: postMessageBodySchema },
    success: { status: 202, description: '受け付けた発言', schema: messageAcceptedEnvelope },
    failures: [...COMMON_FAILURES, 'PRECONDITION_REQUIRED', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  getTaskGuidance: {
    operationId: 'getTaskGuidance',
    method: 'get',
    path: '/cases/:caseId/tasks/:taskId/guidance',
    summary: '手続きの案内',
    description:
      '出典と確認日、調べきれなかった項目を必ず添えて返す。未依頼と依頼済みを区別する。',
    tags: ['chat'],
    auth: 'user',
    request: { params: taskGuidanceParamsSchema },
    success: { status: 200, description: '案内', schema: guidanceEnvelope },
    failures: [...COMMON_FAILURES],
  },
  requestTaskGuidance: {
    operationId: 'requestTaskGuidance',
    method: 'post',
    path: '/cases/:caseId/tasks/:taskId/guidance/requests',
    summary: '手続きの案内を依頼する',
    description:
      '公開された業務操作としてのみ受け付ける。任意のAgent・モデル・Prompt・URLは指定できない。外部AI事業者への提供同意（CROSS_BORDER_AI）が無い、または版が古い場合は保存前に403 CONSENT_REQUIRED（details.requiredConsent）で拒否する。',
    tags: ['chat'],
    auth: 'user',
    request: { params: taskGuidanceParamsSchema },
    success: { status: 202, description: '受け付けた案内', schema: guidanceEnvelope },
    failures: [
      ...COMMON_FAILURES,
      'FEATURE_NOT_CONNECTED',
      'PRECONDITION_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
    ],
    idempotency: 'required',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf({ method: c.req.method, path: c.req.path, body }) } : null,
  }
}

export function createMessageRoutes(service: MessageService): RegisteredRoute[] {
  return [
    defineRoute(messageSpecs.listMessages, async (c, input) => {
      const page = await service.list(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(messageSpecs.postMessage, async (c, input) =>
      accepted(
        c,
        await service.post(
          requireUser(c),
          input.params.caseId,
          input.body.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(messageSpecs.getTaskGuidance, async (c, input) =>
      ok(c, await service.getGuidance(requireUser(c), input.params.caseId, input.params.taskId)),
    ),

    defineRoute(messageSpecs.requestTaskGuidance, async (c, input) => {
      const result = await service.requestGuidance(
        requireUser(c),
        input.params.caseId,
        input.params.taskId,
        commandMeta(c, input.idempotencyKey, { taskId: input.params.taskId }),
      )
      return accepted(c, result.guidance)
    }),
  ]
}
