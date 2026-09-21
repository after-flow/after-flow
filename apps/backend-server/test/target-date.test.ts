import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { targetDateOf } from '../src/domain/task/target-date.js'
import type { DeadlineRule, InitialProcedure, RuleCatalog } from '../src/domain/task/rule-engine.js'

const deliberationRule: DeadlineRule = {
  id: 'fixture-deliberation',
  version: '1.0.0',
  label: '架空の熟慮期間',
  basis: 'KNOWN_AT',
  period: { unit: 'MONTH', count: 3, includeFirstDay: false },
  basisLabel: '自分のために相続が始まったと知った日の翌日から数えて3か月以内',
  knownAtLabel: '自分のために相続が始まったと知った日',
  legalNature: 'STATUTORY',
  jurisdiction: '全国',
  reviewed: true,
  sourceUrl: 'https://example.test/fixture',
  sourceCheckedAt: '2026-09-20T00:00:00+09:00',
  extendable: true,
  critical: true,
  reviewedBy: { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' },
}

function catalogOf(deliberationDeadlineRuleId: string | null): RuleCatalog {
  return {
    placeholder: false,
    deadlineRules: [deliberationRule],
    initialProcedures: [],
    deliberationDeadlineRuleId,
    reviewedBy: { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' },
    reviewedAt: '2026-09-20T00:00:00+09:00',
  }
}

function procedureWithTargetDate(overrides: Partial<InitialProcedure> = {}): InitialProcedure {
  return {
    id: 'fixture-procedure',
    title: '架空の手続き',
    summary: '',
    stage: 'investigation',
    category: '相続',
    submitTo: null,
    evidenceRequired: false,
    assetDisposal: false,
    requiredDocuments: [],
    deadlineRuleId: null,
    applicability: { default: 'yes', rules: [] },
    variants: [],
    targetDate: { monthsBeforeDeliberationDeadline: 1, basisLabel: '相続の方法を決める期限に間に合わせるための目安' },
    ...overrides,
  }
}

describe('targetDateOf', () => {
  it('knownAt 9/15 → 熟慮期間12/15、目安(1か月前)は11/15', () => {
    const facts = targetDateOf(catalogOf('fixture-deliberation'), procedureWithTargetDate(),
      { dateOfDeath: '2026-09-01', knownAt: '2026-09-15' }, 'task-1')
    assert.ok(facts)
    assert.equal(facts!.dueDate, '2026-11-15')
    assert.equal(facts!.critical, false)
    assert.equal(facts!.id, 'target:task-1')
    // ruleId は熟慮期間ルールを継承する（種別判定には id の接頭辞を使う）。
    assert.equal(facts!.ruleId, 'fixture-deliberation')
    assert.equal(facts!.basisLabel, '相続の方法を決める期限に間に合わせるための目安')
  })

  it('knownAt 11/30 → 熟慮期間2027-02-28、目安は2027-01-31', () => {
    const facts = targetDateOf(catalogOf('fixture-deliberation'), procedureWithTargetDate(),
      { dateOfDeath: '2026-11-01', knownAt: '2026-11-30' }, 'task-2')
    assert.equal(facts!.dueDate, '2027-01-31')
  })

  it('procedure.targetDate が null なら null', () => {
    const facts = targetDateOf(catalogOf('fixture-deliberation'), procedureWithTargetDate({ targetDate: null }),
      { dateOfDeath: '2026-09-01', knownAt: '2026-09-15' }, 'task-3')
    assert.equal(facts, null)
  })

  it('deliberationDeadlineRuleId が null なら null', () => {
    const facts = targetDateOf(catalogOf(null), procedureWithTargetDate(),
      { dateOfDeath: '2026-09-01', knownAt: '2026-09-15' }, 'task-4')
    assert.equal(facts, null)
  })

  it('熟慮期間ルールが reviewed:false なら RULE_UNCONFIRMED になる', () => {
    const catalog = catalogOf('fixture-deliberation')
    catalog.deadlineRules[0] = { ...deliberationRule, reviewed: false, reviewedBy: null, sourceUrl: null, sourceCheckedAt: null }
    const facts = targetDateOf(catalog, procedureWithTargetDate(),
      { dateOfDeath: '2026-09-01', knownAt: '2026-09-15' }, 'task-5')
    assert.equal(facts!.confirmation, 'UNCONFIRMED')
    assert.equal(facts!.dueDate, null)
    assert.equal(facts!.unresolvedReason, 'RULE_UNCONFIRMED')
  })

  it('knownAt 未入力なら死亡日で代わりに算定し、付記が basisLabel の熟慮期間側ではなくこのラベルに付く', () => {
    const facts = targetDateOf(catalogOf('fixture-deliberation'), procedureWithTargetDate(),
      { dateOfDeath: '2026-09-01', knownAt: null }, 'task-6')
    assert.match(facts!.basisLabel, /知った日が未入力のため/)
  })
})
