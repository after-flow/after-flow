import { errors } from '../../shared/app-error.js'
import type { DeadlineFacts } from '../task/deadline.js'
import type { BasisDates, RuleCatalog } from '../task/rule-engine.js'
import { buildDeadlineFacts } from '../task/rule-engine.js'

/**
 * 熟慮期間（民法915条）の固定ID。
 *
 * 永続 `DeadlineEntity` の ID ではない。overview 専用のその場算定値で、
 * Task には紐付かない（`taskId` は常に null）。
 */
export const DELIBERATION_DEADLINE_ID = 'deliberation-period'

/**
 * 熟慮期間の期限をその場で算定する（申し送り3-4）。
 *
 * 永続化しない。理由:
 * 1. 熟慮期間はすべての Case に存在する法的事実で、Task の生成条件
 *   （`Case.profile` 等）に依存させたくない。
 * 2. 永続しないので再評価の遅延が無い。Task 側の期限
 *   （`inheritance-choice` ルール）と同じルール・同じ純粋関数
 *   （`buildDeadlineFacts`）から算定するため、再評価後は必ず一致する。
 *   再評価前の一時的な不一致（Case の日付を訂正した直後、Task 側の
 *   `POST /cases/:id/deadlines/reevaluate` がまだ呼ばれていない場合）は
 *   許容する。
 */
export function deliberationDeadlineOf(catalog: RuleCatalog, dates: BasisDates): DeadlineFacts | null {
  if (catalog.deliberationDeadlineRuleId === null) return null
  const rule = catalog.deadlineRules.find((candidate) => candidate.id === catalog.deliberationDeadlineRuleId)
  if (!rule) {
    // カタログ読込時 (`assertRuleCatalogUsable`) にも参照整合を拒否するため、通常はここへ到達しない。
    throw errors.internal({
      internal: { reason: 'unknown deliberation deadline rule', ruleId: catalog.deliberationDeadlineRuleId },
    })
  }
  return buildDeadlineFacts(rule, dates, { id: DELIBERATION_DEADLINE_ID, taskId: null })
}
