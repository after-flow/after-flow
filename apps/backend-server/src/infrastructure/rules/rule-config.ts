import { readFileSync } from 'node:fs'
import { PLACEHOLDER_RULE_CATALOG } from '../../domain/task/rule-catalog.js'
import type { RuleCatalog } from '../../domain/task/rule-engine.js'

/**
 * 期限ルールと初期手続きの定義を設定から読み込む。
 *
 * 仕様書や旧モックの値をそのまま本番ルールにしない。未設定の場合は
 * 業務レビュー未了と分かる仮定義を使い、そこから確定した期限は出さない。
 */
export function readRuleCatalog(env: NodeJS.ProcessEnv = process.env): RuleCatalog {
  const path = env.DEADLINE_RULES_PATH
  if (!path) return PLACEHOLDER_RULE_CATALOG

  const catalog = JSON.parse(readFileSync(path, 'utf8')) as RuleCatalog
  assertUsable(catalog)
  return catalog
}

function assertUsable(catalog: RuleCatalog): void {
  const ruleIds = new Set(catalog.deadlineRules.map((rule) => rule.id))
  if (ruleIds.size !== catalog.deadlineRules.length) {
    throw new Error('期限ルールの ID が重複しています。')
  }
  for (const rule of catalog.deadlineRules) {
    if (rule.offsetDays === undefined && rule.offsetMonths === undefined) {
      throw new Error(`期限ルール ${rule.id} に起算日からの間隔がありません。`)
    }
    if (rule.reviewed && !rule.sourceUrl) {
      // レビュー済みを主張するなら、根拠の所在を必ず残す。
      throw new Error(`期限ルール ${rule.id} は reviewed だが根拠 URL がありません。`)
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
}
