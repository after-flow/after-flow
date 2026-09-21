import { readFileSync } from 'node:fs'
import { PROFILE_FIELDS, PROFILE_VALUES } from '../../domain/case/case-profile.js'
import type { ProfileField } from '../../domain/case/case-profile.js'
import { PLACEHOLDER_RULE_CATALOG } from '../../domain/task/rule-catalog.js'
import { MAX_INITIAL_PROCEDURES } from '../../domain/task/rule-engine.js'
import type {
  InitialProcedure,
  ProcedureCondition,
  ReviewerQualification,
  RuleCatalog,
} from '../../domain/task/rule-engine.js'

/** placeholder カタログでも許すのは実装者照合（ENGINEER）だけ。本番はここから ENGINEER を除いたものだけを許す。 */
const REVIEWER_QUALIFICATIONS: readonly ReviewerQualification[] = [
  'ENGINEER',
  'JUDICIAL_SCRIVENER',
  'TAX_ACCOUNTANT',
  'SOCIAL_INSURANCE_CONSULTANT',
  'LAWYER',
]

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
  // キーを省略した設定ファイル (undefined) は「熟慮期間を出さない」「未確認」として扱う。
  // それ以外の新キー（knownAtLabel/applicability/variants/targetDate）は補完せず、
  // 検証で落として設定ファイル側に明示させる。
  const catalog: RuleCatalog = {
    ...parsed,
    deliberationDeadlineRuleId: parsed.deliberationDeadlineRuleId ?? null,
    reviewedBy: parsed.reviewedBy ?? null,
    reviewedAt: parsed.reviewedAt ?? null,
    deadlineRules: parsed.deadlineRules.map((rule) => ({
      ...rule,
      reviewedBy: rule.reviewedBy ?? null,
    })),
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
    if (rule.basis === 'KNOWN_AT' && (!rule.knownAtLabel || rule.knownAtLabel.trim().length === 0)) {
      throw new Error(`期限ルール ${rule.id}: KNOWN_AT のルールには knownAtLabel が必要です。`)
    }
    if (rule.basis === 'DATE_OF_DEATH' && rule.knownAtLabel !== null) {
      throw new Error(`期限ルール ${rule.id}: DATE_OF_DEATH のルールに knownAtLabel を持たせられません。`)
    }
    if (rule.reviewed) {
      assertReviewer(rule.reviewedBy, `期限ルール ${rule.id}`)
      if (!catalog.placeholder && rule.reviewedBy?.qualification === 'ENGINEER') {
        throw new Error(`期限ルール ${rule.id}: 本番カタログ（placeholder:false）では専門職の reviewer が必要です（ENGINEER は不可）。`)
      }
    }
  }

  if (!catalog.placeholder) {
    if (!catalog.reviewedBy || !catalog.reviewedAt) {
      throw new Error('本番カタログ（placeholder:false）には reviewedBy と reviewedAt が必要です。')
    }
    assertReviewer(catalog.reviewedBy, 'カタログ')
    if (catalog.reviewedBy.qualification === 'ENGINEER') {
      throw new Error('本番カタログ（placeholder:false）の reviewedBy を ENGINEER にできません。')
    }
  } else if (catalog.reviewedBy) {
    assertReviewer(catalog.reviewedBy, 'カタログ')
  }

  const procedureIds = new Set(catalog.initialProcedures.map((procedure) => procedure.id))
  if (procedureIds.size !== catalog.initialProcedures.length) {
    throw new Error('初期手続きの ID が重複しています。')
  }
  if (catalog.initialProcedures.length > MAX_INITIAL_PROCEDURES) {
    throw new Error(`初期手続きの件数が上限（${MAX_INITIAL_PROCEDURES}）を超えています。`)
  }
  for (const procedure of catalog.initialProcedures) {
    if (procedure.deadlineRuleId && !ruleIds.has(procedure.deadlineRuleId)) {
      throw new Error(`初期手続き ${procedure.id} が参照する期限ルールがありません。`)
    }
    assertProcedureShape(procedure, ruleIds)
  }
  if (catalog.deliberationDeadlineRuleId !== null && !ruleIds.has(catalog.deliberationDeadlineRuleId)) {
    throw new Error('熟慮期間 (deliberationDeadlineRuleId) が参照する期限ルールがありません。')
  }

  const deliberationRule = catalog.deliberationDeadlineRuleId
    ? catalog.deadlineRules.find((rule) => rule.id === catalog.deliberationDeadlineRuleId)
    : null
  for (const procedure of catalog.initialProcedures) {
    if (procedure.targetDate === null) continue
    if (!deliberationRule) {
      throw new Error(`初期手続き ${procedure.id}: targetDate を使うには deliberationDeadlineRuleId が必要です。`)
    }
    if (deliberationRule.period.unit === 'DAY') {
      throw new Error(`初期手続き ${procedure.id}: 熟慮期間ルールの period.unit が DAY のため targetDate を算定できません。`)
    }
    if (!Number.isInteger(procedure.targetDate.monthsBeforeDeliberationDeadline)
      || procedure.targetDate.monthsBeforeDeliberationDeadline < 1) {
      throw new Error(`初期手続き ${procedure.id}: targetDate.monthsBeforeDeliberationDeadline は1以上の整数が必要です。`)
    }
    const totalMonths = deliberationRule.period.unit === 'YEAR'
      ? deliberationRule.period.count * 12
      : deliberationRule.period.count
    if (totalMonths - procedure.targetDate.monthsBeforeDeliberationDeadline < 1) {
      throw new Error(`初期手続き ${procedure.id}: targetDate が熟慮期間の月数を超えています。`)
    }
    if (!procedure.targetDate.basisLabel || procedure.targetDate.basisLabel.trim().length === 0) {
      throw new Error(`初期手続き ${procedure.id}: targetDate.basisLabel が空です。`)
    }
  }
}

function assertReviewer(reviewer: RuleCatalog['reviewedBy'], subject: string): void {
  if (!reviewer) throw new Error(`${subject}: reviewedBy が必要です。`)
  if (!reviewer.name || reviewer.name.trim().length === 0) {
    throw new Error(`${subject}: reviewedBy.name が空です。`)
  }
  if (!REVIEWER_QUALIFICATIONS.includes(reviewer.qualification)) {
    throw new Error(`${subject}: reviewedBy.qualification が不正です。`)
  }
}

function assertProcedureShape(procedure: InitialProcedure, ruleIds: Set<string>): void {
  if (procedure.applicability === undefined) {
    throw new Error(`初期手続き ${procedure.id}: applicability が必要です。`)
  }
  if (procedure.variants === undefined) {
    throw new Error(`初期手続き ${procedure.id}: variants が必要です（無ければ空配列）。`)
  }
  if (procedure.targetDate === undefined) {
    throw new Error(`初期手続き ${procedure.id}: targetDate が必要です（無ければ null）。`)
  }
  const inclusions = ['yes', 'maybe', 'no']
  if (!inclusions.includes(procedure.applicability.default)) {
    throw new Error(`初期手続き ${procedure.id}: applicability.default が不正です。`)
  }
  for (const rule of procedure.applicability.rules) {
    if (!inclusions.includes(rule.include)) {
      throw new Error(`初期手続き ${procedure.id}: applicability.rules[].include が不正です。`)
    }
    assertCondition(rule.when, procedure.id, 0)
  }
  for (const variant of procedure.variants) {
    assertCondition(variant.when, procedure.id, 0)
    if (variant.deadlineRuleId !== undefined && variant.deadlineRuleId !== null && !ruleIds.has(variant.deadlineRuleId)) {
      throw new Error(`初期手続き ${procedure.id}: variant が参照する期限ルールがありません。`)
    }
  }
}

const MAX_CONDITION_DEPTH = 8

function assertCondition(cond: ProcedureCondition, procedureId: string, depth: number): void {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new Error(`初期手続き ${procedureId}: 条件のネストが深すぎます。`)
  }
  if ('field' in cond) {
    if (!PROFILE_FIELDS.includes(cond.field as ProfileField)) {
      throw new Error(`初期手続き ${procedureId}: 条件の field が不正です。`)
    }
    const allowed = PROFILE_VALUES[cond.field as ProfileField] as readonly string[]
    if (!cond.in || cond.in.length === 0 || cond.in.some((value) => !allowed.includes(value))) {
      throw new Error(`初期手続き ${procedureId}: 条件の in が不正です。`)
    }
    return
  }
  if ('ageAtDeath' in cond) {
    const { gte, lt } = cond.ageAtDeath
    if (gte === undefined && lt === undefined) {
      throw new Error(`初期手続き ${procedureId}: ageAtDeath には gte か lt の少なくとも一方が必要です。`)
    }
    for (const value of [gte, lt]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(`初期手続き ${procedureId}: ageAtDeath の gte/lt は非負整数が必要です。`)
      }
    }
    return
  }
  if ('all' in cond || 'any' in cond) {
    const children = 'all' in cond ? cond.all : cond.any
    if (children.length === 0) {
      throw new Error(`初期手続き ${procedureId}: all/any は空配列にできません。`)
    }
    for (const child of children) assertCondition(child, procedureId, depth + 1)
    return
  }
  assertCondition(cond.not, procedureId, depth + 1)
}
