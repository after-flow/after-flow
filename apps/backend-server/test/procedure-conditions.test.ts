import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateCondition, inclusionOf, resolveProcedure } from '../src/domain/task/procedure-conditions.js'
import type { ProcedureFacts } from '../src/domain/case/case-profile.js'
import type { InitialProcedure, ProcedureCondition } from '../src/domain/task/rule-engine.js'

function factsOf(overrides: Partial<ProcedureFacts> = {}): ProcedureFacts {
  return {
    dateOfDeath: '2026-04-01',
    knownAt: '2026-04-03',
    dateOfBirth: null,
    profile: null,
    ...overrides,
  }
}

describe('evaluateCondition', () => {
  it('field in: profile が null なら UNKNOWN として評価する', () => {
    const cond: ProcedureCondition = { field: 'pension', in: ['UNKNOWN'] }
    assert.equal(evaluateCondition(cond, factsOf({ profile: null })), true)
  })

  it('field in: 未回答（UNKNOWN）は明示しないと当たらない', () => {
    const cond: ProcedureCondition = { field: 'pension', in: ['EMPLOYEES'] }
    assert.equal(evaluateCondition(cond, factsOf({ profile: null })), false)
  })

  it('field in: profile の値で判定する', () => {
    const facts = factsOf({
      profile: {
        healthInsurance: 'UNKNOWN', pension: 'EMPLOYEES', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    assert.equal(evaluateCondition({ field: 'pension', in: ['EMPLOYEES'] }, facts), true)
    assert.equal(evaluateCondition({ field: 'pension', in: ['NATIONAL_ONLY'] }, facts), false)
  })

  it('ageAtDeath: 年齢が null（生年月日なし）なら常に false', () => {
    assert.equal(evaluateCondition({ ageAtDeath: { gte: 65 } }, factsOf({ dateOfBirth: null })), false)
  })

  it('ageAtDeath: gte/lt', () => {
    const facts = factsOf({ dateOfBirth: '1950-01-01', dateOfDeath: '2026-01-01' })
    assert.equal(evaluateCondition({ ageAtDeath: { gte: 65 } }, facts), true)
    assert.equal(evaluateCondition({ ageAtDeath: { gte: 77 } }, facts), false)
    assert.equal(evaluateCondition({ ageAtDeath: { lt: 77 } }, facts), true)
    assert.equal(evaluateCondition({ ageAtDeath: { lt: 76 } }, facts), false)
  })

  it('all / any / not', () => {
    const facts = factsOf({
      profile: {
        healthInsurance: 'EMPLOYEE', pension: 'UNKNOWN', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    const all: ProcedureCondition = { all: [{ field: 'healthInsurance', in: ['EMPLOYEE'] }, { field: 'pension', in: ['UNKNOWN'] }] }
    assert.equal(evaluateCondition(all, facts), true)
    const any: ProcedureCondition = { any: [{ field: 'healthInsurance', in: ['NATIONAL'] }, { field: 'pension', in: ['UNKNOWN'] }] }
    assert.equal(evaluateCondition(any, facts), true)
    const not: ProcedureCondition = { not: { field: 'healthInsurance', in: ['EMPLOYEE'] } }
    assert.equal(evaluateCondition(not, facts), false)
  })
})

function baseProcedure(overrides: Partial<InitialProcedure> = {}): InitialProcedure {
  return {
    id: 'fixture',
    title: '基本タイトル',
    summary: '基本サマリー',
    stage: 'immediate',
    category: 'カテゴリ',
    submitTo: '基本窓口',
    evidenceRequired: false,
    assetDisposal: false,
    requiredDocuments: [],
    deadlineRuleId: 'fixture-rule',
    applicability: { default: 'yes', rules: [] },
    variants: [],
    targetDate: null,
    ...overrides,
  }
}

describe('inclusionOf', () => {
  it('ルールに何も当たらなければ default を返す', () => {
    assert.equal(inclusionOf(baseProcedure({ applicability: { default: 'no', rules: [] } }), factsOf()), 'no')
  })

  it('上から順に評価し、最初に当たったものを採る', () => {
    const procedure = baseProcedure({
      applicability: {
        default: 'maybe',
        rules: [
          { when: { field: 'pension', in: ['NONE'] }, include: 'no' },
          { when: { field: 'pension', in: ['NONE', 'EMPLOYEES'] }, include: 'yes' },
        ],
      },
    })
    const facts = factsOf({
      profile: {
        healthInsurance: 'UNKNOWN', pension: 'NONE', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    assert.equal(inclusionOf(procedure, facts), 'no')
  })
})

describe('resolveProcedure', () => {
  it('当たった variant が無ければ基本値のまま', () => {
    const procedure = baseProcedure()
    const resolved = resolveProcedure(procedure, factsOf())
    assert.equal(resolved.title, '基本タイトル')
    assert.equal(resolved.deadlineRuleId, 'fixture-rule')
  })

  it('最初に当たった1件だけを適用する（複数当たっても合成しない）', () => {
    const procedure = baseProcedure({
      variants: [
        { when: { field: 'pension', in: ['EMPLOYEES'] }, title: 'A' },
        { when: { field: 'pension', in: ['EMPLOYEES'] }, title: 'B' },
      ],
    })
    const facts = factsOf({
      profile: {
        healthInsurance: 'UNKNOWN', pension: 'EMPLOYEES', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    assert.equal(resolveProcedure(procedure, facts).title, 'A')
  })

  it('deadlineRuleId: null の明示的上書きと省略（継承）を区別する', () => {
    const facts = factsOf({
      profile: {
        healthInsurance: 'EMPLOYEE', pension: 'UNKNOWN', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    const overridden = baseProcedure({
      variants: [{ when: { field: 'healthInsurance', in: ['EMPLOYEE'] }, deadlineRuleId: null }],
    })
    assert.equal(resolveProcedure(overridden, facts).deadlineRuleId, null)

    const inherited = baseProcedure({
      variants: [{ when: { field: 'healthInsurance', in: ['EMPLOYEE'] }, title: '別タイトル' }],
    })
    assert.equal(resolveProcedure(inherited, facts).deadlineRuleId, 'fixture-rule')
  })

  it('submitTo も省略なら継承、null なら上書きする', () => {
    const facts = factsOf({
      profile: {
        healthInsurance: 'EMPLOYEE', pension: 'UNKNOWN', occupation: 'UNKNOWN',
        realEstate: 'UNKNOWN', car: 'UNKNOWN', mortgage: 'UNKNOWN', answeredAt: '2026-09-20T00:00:00+09:00',
      },
    })
    const overridden = baseProcedure({
      variants: [{ when: { field: 'healthInsurance', in: ['EMPLOYEE'] }, submitTo: null }],
    })
    assert.equal(resolveProcedure(overridden, facts).submitTo, null)

    const inherited = baseProcedure({
      variants: [{ when: { field: 'healthInsurance', in: ['EMPLOYEE'] }, title: '別タイトル' }],
    })
    assert.equal(resolveProcedure(inherited, facts).submitTo, '基本窓口')
  })
})
