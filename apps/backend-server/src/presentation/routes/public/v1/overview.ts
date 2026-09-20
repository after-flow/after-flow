import type { CaseOverviewService } from '../../../../application/overview/overview-service.js'
import { requireUser } from '../../../http/authentication.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import { successEnvelope } from '../../../schemas/common.js'
import { caseOverviewResourceSchema } from '../../../schemas/overview.js'

export const overviewSpecs = {
  getCaseOverview: {
    operationId: 'getCaseOverview',
    method: 'get',
    path: '/cases/:caseId/overview',
    summary: '案件の概要',
    description:
      '保存済みの状態を集計クエリで数える。一覧の1ページ目だけを数えず、対象の手続きが0件の段階は完了にしない。',
    tags: ['overview'],
    auth: 'user',
    request: { params: caseIdParamsSchema },
    success: {
      status: 200,
      description: '集約した概要',
      schema: successEnvelope(caseOverviewResourceSchema),
    },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
  },
} satisfies Record<string, RouteSpec>

export function createOverviewRoutes(service: CaseOverviewService): RegisteredRoute[] {
  return [
    defineRoute(overviewSpecs.getCaseOverview, async (c, input) =>
      ok(c, await service.get(requireUser(c), input.params.caseId)),
    ),
  ]
}
