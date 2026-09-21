import { readFileSync } from 'node:fs'
import { PLACEHOLDER_RULE_CATALOG } from '../../domain/task/rule-catalog.js'
import type { RuleCatalog } from '../../domain/task/rule-engine.js'

/**
 * 期限ルールと初期手続きの定義を設定から読み込む。
 *
 * 仕様書や旧モックの値をそのまま本番ルールにしない。未設定の場合は
 * 業務レビュー未了と分かる仮定義を使い、そこから確定した期限は出さない。
 * 本番（`NODE_ENV=production`）では未設定・`placeholder: true` のいずれも
 * 拒否する（`infrastructure/consent/catalog-config.ts` の同意カタログと
 * 同じ扱い）。正式カタログが確定するまで、本番デプロイはこのガードで
 * 止まる。これは意図した挙動で、未承認の期限を本番で表示しないことを
 * 優先する。
 */
export function readRuleCatalog(env: NodeJS.ProcessEnv = process.env): RuleCatalog {
  const path = env.DEADLINE_RULES_PATH

  if (!path) {
    if (env.NODE_ENV === 'production') {
      throw new Error('DEADLINE_RULES_PATH が未設定です。未確定の仮ルールのまま本番で期限を算定しない。')
    }
    return PLACEHOLDER_RULE_CATALOG
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RuleCatalog
  // キーを省略した設定ファイル (undefined) は「熟慮期間を出さない」として扱う。
  const catalog: RuleCatalog = {
    ...parsed,
    deliberationDeadlineRuleId: parsed.deliberationDeadlineRuleId ?? null,
  }
  if (catalog.placeholder && env.NODE_ENV === 'production') {
    throw new Error('placeholder: true のカタログは本番で使用できません。')
  }
  assertRuleCatalogUsable(catalog)
  return catalog
}

/**
 * カタログの整合性検証。
 *
 * `PLACEHOLDER_RULE_CATALOG` にも（読込関数を通らないため）テストで
 * 同じ検証をかける。
 */
export function assertRuleCatalogUsable(catalog: RuleCatalog): void {
  if (typeof catalog.placeholder !== 'boolean') {
    // 省略を「本番可」と読まれないよう、明示を必須にする。
    throw new Error('カタログの placeholder は boolean で明示する必要があります。')
  }
  const ruleIds = new Set(catalog.deadlineRules.map((rule) => rule.id))
  if (ruleIds.size !== catalog.deadlineRules.length) {
    throw new Error('期限ルールの ID が重複しています。')
  }
  for (const rule of catalog.deadlineRules) {
    if (!rule.period || !['DAY', 'MONTH', 'YEAR'].includes(rule.period.unit)) {
      throw new Error(`期限ルール ${rule.id} の period.unit が不正です。`)
    }
    if (!Number.isInteger(rule.period.count) || rule.period.count < 1) {
      throw new Error(`期限ルール ${rule.id} の period.count は正の整数である必要があります。`)
    }
    if (typeof rule.period.includeFirstDay !== 'boolean') {
      throw new Error(`期限ルール ${rule.id} の period.includeFirstDay が boolean ではありません。`)
    }
    if (!rule.basisLabel || rule.basisLabel.trim().length === 0) {
      throw new Error(`期限ルール ${rule.id} に basisLabel がありません。利用者が自分で数え直せる根拠文が必要です。`)
    }
    if (rule.legalNature !== 'STATUTORY' && rule.legalNature !== 'JURISDICTIONAL') {
      throw new Error(`期限ルール ${rule.id} の legalNature が不正です。`)
    }
    if (rule.reviewed && (!rule.sourceUrl || !rule.sourceCheckedAt)) {
      // レビュー済みを主張するなら、根拠の所在といつ確認したかを必ず残す。
      throw new Error(`期限ルール ${rule.id} は reviewed だが根拠 URL または確認日時がありません。`)
    }
    if (catalog.placeholder && rule.reviewed && rule.legalNature !== 'STATUTORY') {
      // placeholder カタログでは、条文だけで一意に定まる STATUTORY 以外を
      // reviewed にしない。自治体・機関依存の期限は業務レビューを待つ。
      throw new Error(`期限ルール ${rule.id}: placeholder カタログで reviewed にできるのは STATUTORY のルールだけです。`)
    }
  }
  const procedureIds = new Set(catalog.initialProcedures.map((procedure) => procedure.id))
  if (procedureIds.size !== catalog.initialProcedures.length) {
    throw new Error('初期手続きの ID が重複しています。')
  }
  for (const procedure of catalog.initialProcedures) {
    if (procedure.deadlineRuleId && !ruleIds.has(procedure.deadlineRuleId)) {
      throw new Error(`初期手続き ${procedure.id} が参照する期限ルールがありません。`)
    }
  }
  if (catalog.deliberationDeadlineRuleId !== null && !ruleIds.has(catalog.deliberationDeadlineRuleId)) {
    throw new Error('熟慮期間 (deliberationDeadlineRuleId) が参照する期限ルールがありません。')
  }
}
