import { z } from 'zod'
import type { CaseService } from '../../../../application/case/case-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import {
  caseIdParamsSchema,
  caseResourceSchema,
  createCaseBodySchema,
  updateCaseBodySchema,
  updatePlanningRestrictionBodySchema,
} from '../../../schemas/case.js'
import { listQuerySchema, successEnvelope } from '../../../schemas/common.js'

const caseEnvelope = successEnvelope(caseResourceSchema)
const caseListEnvelope = successEnvelope(z.array(caseResourceSchema))

/**
 * Case の公開 API。
 *
 * spec と handler を分けてあるのは、OpenAPI の生成に実行時の依存を
 * 持ち込まないため。route を足したら spec も必ず一覧に載る。
 */
export const caseSpecs = {
  createCase: {
    operationId: 'createCase',
    method: 'post',
    path: '/cases',
    summary: '案件を作成する',
    description:
      '作成者を OWNER として membership を同じ Transaction で確定する。`ownerPerson` を指定すると本人を ' +
      'Person として同時登録し `ownerPersonId` に紐付ける（省略時は従来どおり後から POST /cases/:caseId/persons ' +
      'で登録する）。未来の死亡日、死亡日より前または未来の「知った日」は 400。初期手続きと期限の生成は別の処理が行う。',
    tags: ['cases'],
    auth: 'user',
    request: { body: createCaseBodySchema },
    success: { status: 201, description: '作成した案件', schema: caseEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'PRECONDITION_REQUIRED', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  listCases: {
    operationId: 'listCases',
    method: 'get',
    path: '/cases',
    summary: '自分が参加している案件の一覧',
    description: '続きは meta.nextCursor で取得する。件数から全件を推測しない。',
    tags: ['cases'],
    auth: 'user',
    request: { query: listQuerySchema },
    success: { status: 200, description: '案件の一覧', schema: caseListEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN'],
    list: true,
  },
  getCase: {
    operationId: 'getCase',
    method: 'get',
    path: '/cases/:caseId',
    summary: '案件の詳細',
    tags: ['cases'],
    auth: 'user',
    request: { params: caseIdParamsSchema },
    success: { status: 200, description: '案件', schema: caseEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND'],
  },
  setPlanningRestriction: {
    operationId: 'setPlanningRestriction', method: 'patch', path: '/cases/:caseId/ai-planning-restriction',
    summary: 'AIによる手続き提案を停止・解除する',
    description: 'OWNERのみ。理由付きのrestrictionで案件全体のAI提案を停止し、nullで解除する。案件版が進み、既存の計画・承認は再評価が必要になる。個別手続きの禁止や本人意思の確定ではない。',
    tags: ['cases'], auth: 'user',
    request: { params: caseIdParamsSchema, body: updatePlanningRestrictionBodySchema },
    success: { status: 200, description: '更新後の案件', schema: caseEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'IDEMPOTENCY_KEY_REUSED'],
    expectedVersion: 'required', idempotency: 'required',
  },
  updateCase: {
    operationId: 'updateCase',
    method: 'patch',
    path: '/cases/:caseId',
    summary: '案件の基本情報を訂正する',
    description:
      'status は変更できない。死亡日と「知った日」は別の事実として保持し、未入力を補完しない。' +
      '死亡日・「知った日」を変更する場合、未来の死亡日、死亡日より前または未来の「知った日」は 400。' +
      'ownerPersonId は含められない（変更したい場合は別途対応する）。',
    tags: ['cases'],
    auth: 'user',
    request: { params: caseIdParamsSchema, body: updateCaseBodySchema },
    success: { status: 200, description: '訂正後の案件', schema: caseEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ],
    expectedVersion: 'required',
    idempotency: 'required',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey
      ? // 内容そのものは保存せず、指紋だけで同一性を判定する。
        { key: idempotencyKey, fingerprint: fingerprintOf({ method: c.req.method, path: c.req.path, body }) }
      : null,
  }
}

export function createCaseRoutes(service: CaseService): RegisteredRoute[] {
  return [
    defineRoute(caseSpecs.createCase, async (c, input) => {
      const created = await service.create(
        requireUser(c),
        input.body,
        commandMeta(c, input.idempotencyKey, input.body),
      )
      return ok(c, created, { status: 201 })
    }),

    defineRoute(caseSpecs.listCases, async (c, input) => {
      const page = await service.list(requireUser(c), {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(caseSpecs.getCase, async (c, input) =>
      ok(c, await service.get(requireUser(c), input.params.caseId)),
    ),

    defineRoute(caseSpecs.setPlanningRestriction, async (c, input) =>
      ok(c, await service.setPlanningRestriction(requireUser(c), input.params.caseId,
        input.body.expectedVersion, input.body.restriction, commandMeta(c, input.idempotencyKey, input.body))),
    ),

    defineRoute(caseSpecs.updateCase, async (c, input) => {
      const { expectedVersion, ...patch } = input.body
      const updated = await service.update(
        requireUser(c),
        input.params.caseId,
        expectedVersion,
        patch,
        commandMeta(c, input.idempotencyKey, input.body),
      )
      return ok(c, updated)
    }),
  ]
}
