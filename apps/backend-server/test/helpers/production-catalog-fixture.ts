import type { Reviewer, RuleCatalog } from '../../src/domain/task/rule-engine.js'

/**
 * `placeholder:false`（本番相当）の最小カタログ。
 *
 * 1.5 節のカタログ検証（本番は reviewer が専門職であることを必須にする）を
 * 満たす最小のフィクスチャ。`test/rule-catalog.test.ts`・
 * `test/composition-readiness.test.ts`・`test/firestore/readiness-composition.test.ts`
 * で共有する。
 */
export const PRODUCTION_REVIEWER: Reviewer = { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' }
export const PRODUCTION_REVIEWED_AT = '2026-09-22T00:00:00+09:00'

export const PRODUCTION_MIN_CATALOG: RuleCatalog = {
  placeholder: false,
  deadlineRules: [],
  initialProcedures: [],
  deliberationDeadlineRuleId: null,
  reviewedBy: PRODUCTION_REVIEWER,
  reviewedAt: PRODUCTION_REVIEWED_AT,
}

/** JSON 設定ファイル用（readRuleCatalog のテストなど）。 */
export const PRODUCTION_MIN_CATALOG_JSON = JSON.stringify(PRODUCTION_MIN_CATALOG)
