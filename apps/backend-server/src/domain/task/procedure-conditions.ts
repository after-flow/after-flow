import { ageAtDeath } from '../case/case-profile.js'
import type { ProcedureFacts } from '../case/case-profile.js'
import type { InitialProcedure, ProcedureCondition, ProcedureInclusion } from './rule-engine.js'

/** 条件木を Case の事実に対して評価する。純粋関数。 */
export function evaluateCondition(cond: ProcedureCondition, facts: ProcedureFacts): boolean {
  if ('field' in cond) {
    const value = facts.profile?.[cond.field] ?? 'UNKNOWN'
    return cond.in.includes(value)
  }
  if ('ageAtDeath' in cond) {
    const age = ageAtDeath(facts.dateOfBirth, facts.dateOfDeath)
    if (age === null) return false
    if (cond.ageAtDeath.gte !== undefined && age < cond.ageAtDeath.gte) return false
    if (cond.ageAtDeath.lt !== undefined && age >= cond.ageAtDeath.lt) return false
    return true
  }
  if ('all' in cond) return cond.all.every((child) => evaluateCondition(child, facts))
  if ('any' in cond) return cond.any.some((child) => evaluateCondition(child, facts))
  return !evaluateCondition(cond.not, facts)
}

/** 手続きの適用可否。上から順に評価し最初に当たったものを採る。 */
export function inclusionOf(procedure: InitialProcedure, facts: ProcedureFacts): ProcedureInclusion {
  for (const rule of procedure.applicability.rules) {
    if (evaluateCondition(rule.when, facts)) return rule.include
  }
  return procedure.applicability.default
}

export interface ResolvedProcedure {
  include: ProcedureInclusion
  title: string
  summary: string
  submitTo: string | null
  deadlineRuleId: string | null
}

/** variants を上から評価し、最初に当たった 1 件だけを基本値に重ねる（複数の variant を合成しない）。 */
export function resolveProcedure(procedure: InitialProcedure, facts: ProcedureFacts): ResolvedProcedure {
  const include = inclusionOf(procedure, facts)
  const base: ResolvedProcedure = {
    include,
    title: procedure.title,
    summary: procedure.summary,
    submitTo: procedure.submitTo,
    deadlineRuleId: procedure.deadlineRuleId,
  }
  const variant = procedure.variants.find((candidate) => evaluateCondition(candidate.when, facts))
  if (!variant) return base
  return {
    include,
    title: variant.title ?? base.title,
    summary: variant.summary ?? base.summary,
    submitTo: 'submitTo' in variant ? (variant.submitTo ?? null) : base.submitTo,
    deadlineRuleId: 'deadlineRuleId' in variant ? (variant.deadlineRuleId ?? null) : base.deadlineRuleId,
  }
}
