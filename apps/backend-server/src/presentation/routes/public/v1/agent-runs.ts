import { z } from 'zod'
import type { AgentRunService } from '../../../../application/agent/agent-run-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { accepted, ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import {
  acceptAgentRunBodySchema,
  agentRunActionBodySchema,
  agentRunIdParamsSchema,
  agentRunResourceSchema,
} from '../../../schemas/agent.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import { listQuerySchema, successEnvelope } from '../../../schemas/common.js'

const runEnvelope = successEnvelope(agentRunResourceSchema)
const runListEnvelope = successEnvelope(z.array(agentRunResourceSchema))

export const agentRunSpecs = {
  acceptAgentRun: {
    operationId: 'acceptAgentRun',
    method: 'post',
    path: '/cases/:caseId/agent-runs',
    summary: 'AIの処理を受け付ける',
    description:
      '202で受け付けるだけで完了ではない。結果は取得APIで別途確認する。接続されていない操作と同意不足は理由付きで拒否する。',
    tags: ['agent-runs'],
    auth: 'user',
    request: { params: caseIdParamsSchema, body: acceptAgentRunBodySchema },
    success: { status: 202, description: '受け付けた実行', schema: runEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'FEATURE_NOT_CONNECTED',
      'PRECONDITION_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
    ],
    idempotency: 'required',
  },
  listAgentRuns: {
    operationId: 'listAgentRuns',
    method: 'get',
    path: '/cases/:caseId/agent-runs',
    summary: 'AIの処理の一覧',
    tags: ['agent-runs'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '実行の一覧', schema: runListEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
    list: true,
  },
  getAgentRun: {
    operationId: 'getAgentRun',
    method: 'get',
    path: '/cases/:caseId/agent-runs/:runId',
    summary: 'AIの処理の状態',
    description: '待機・失敗・取消を区別して返す。待機は失敗ではない。',
    tags: ['agent-runs'],
    auth: 'user',
    request: { params: agentRunIdParamsSchema },
    success: { status: 200, description: '実行', schema: runEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
  },
  cancelAgentRun: {
    operationId: 'cancelAgentRun',
    method: 'post',
    path: '/cases/:caseId/agent-runs/:runId/cancel',
    summary: 'AIの処理を取り消す',
    description:
      '取り消すのは実行であって、既に確定した業務変更ではない。確定済みの変更を戻す操作は別に用意する。',
    tags: ['agent-runs'],
    auth: 'user',
    request: { params: agentRunIdParamsSchema, body: agentRunActionBodySchema },
    success: { status: 200, description: '取消後の実行', schema: runEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
  retryAgentRun: {
    operationId: 'retryAgentRun',
    method: 'post',
    path: '/cases/:caseId/agent-runs/:runId/retry',
    summary: 'AIの処理を再試行する',
    description: '新しい試行として受け付ける。成功済みの操作は再実行しない。',
    tags: ['agent-runs'],
    auth: 'user',
    request: { params: agentRunIdParamsSchema, body: agentRunActionBodySchema },
    success: { status: 202, description: '再試行を受け付けた実行', schema: runEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf(body) } : null,
  }
}

export function createAgentRunRoutes(service: AgentRunService): RegisteredRoute[] {
  return [
    defineRoute(agentRunSpecs.acceptAgentRun, async (c, input) =>
      accepted(
        c,
        await service.accept(
          requireUser(c),
          input.params.caseId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(agentRunSpecs.listAgentRuns, async (c, input) => {
      const page = await service.list(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(agentRunSpecs.getAgentRun, async (c, input) =>
      ok(c, await service.get(requireUser(c), input.params.caseId, input.params.runId)),
    ),

    defineRoute(agentRunSpecs.cancelAgentRun, async (c, input) =>
      ok(
        c,
        await service.cancel(
          requireUser(c),
          input.params.caseId,
          input.params.runId,
          input.body.expectedVersion,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(agentRunSpecs.retryAgentRun, async (c, input) =>
      accepted(
        c,
        await service.retry(
          requireUser(c),
          input.params.caseId,
          input.params.runId,
          input.body.expectedVersion,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),
  ]
}
