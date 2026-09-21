import { errors } from '../../shared/app-error.js'
import { buildDeadlineFacts } from './rule-engine.js'
import type { BasisDates, InitialProcedure, RuleCatalog } from './rule-engine.js'
import type { DeadlineFacts } from './deadline.js'

/**
 * 申し送り 11-1 の「目安の期限」。永続しない。Task view 生成のたびに
 * `deliberationDeadlineOf` と同じ純粋関数から算定する。
 *
 * `id` は `target:` 接頭辞を持つ（`ruleId` は熟慮期間ルールを継承するので、
 * 種別判定には `id` を使う。詳細は `TaskResource.targetDate` の JSDoc）。
 */
export function targetDateOf(
  catalog: RuleCatalog,
  procedure: InitialProcedure,
  dates: BasisDates,
  taskId: string,
): DeadlineFacts | null {
  if (procedure.targetDate === null || catalog.deliberationDeadlineRuleId === null) return null
  const rule = catalog.deadlineRules.find((candidate) => candidate.id === catalog.deliberationDeadlineRuleId)
  if (!rule) {
    throw errors.internal({
      internal: { reason: 'unknown deliberation deadline rule', ruleId: catalog.deliberationDeadlineRuleId },
    })
  }
  const totalMonths = rule.period.unit === 'YEAR' ? rule.period.count * 12 : rule.period.count
  const months = totalMonths - procedure.targetDate.monthsBeforeDeliberationDeadline
  const derived = {
    ...rule,
    label: '目安の期限',
    basisLabel: procedure.targetDate.basisLabel,
    period: { unit: 'MONTH' as const, count: months, includeFirstDay: rule.period.includeFirstDay },
    critical: false,
    extendable: null,
  }
  return buildDeadlineFacts(derived, dates, { id: `target:${taskId}`, taskId })
}
