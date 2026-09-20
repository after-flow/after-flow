import type { CaseService } from '../../../../application/case/case-service.js'
import { errors } from '../../../../shared/app-error.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseSpecs, createCaseRoutes } from './cases.js'
import { healthRoute, healthSpec } from './health.js'

/**
 * 公開 API v1 の契約一覧。
 *
 * OpenAPI の生成と契約試験はこの配列を唯一の入力にする。
 * 実行時の依存を持たないため、Firestore や認証の設定が無くても生成できる。
 */
export const publicV1Specs: RouteSpec[] = [
  healthSpec,
  caseSpecs.createCase,
  caseSpecs.listCases,
  caseSpecs.getCase,
  caseSpecs.updateCase,
]

export interface PublicRouteDependencies {
  caseService: CaseService
}

/**
 * 業務機能が接続されていない場合の route。
 *
 * 契約には存在するが実機能が無い状態を、404 や空配列で隠さない。
 * 「まだ接続されていない」と理由付きで返す。
 */
function notConnected(specs: RouteSpec[]): RegisteredRoute[] {
  return specs.map((spec) =>
    defineRoute(spec, () => {
      throw errors.featureNotConnected({
        details: { operation: spec.operationId, reason: 'business database is not configured' },
      })
    }),
  )
}

export function createPublicV1Routes(
  dependencies: PublicRouteDependencies | null,
): RegisteredRoute[] {
  const businessSpecs = publicV1Specs.filter((spec) => spec !== healthSpec)
  return [
    healthRoute,
    ...(dependencies ? createCaseRoutes(dependencies.caseService) : notConnected(businessSpecs)),
  ]
}
