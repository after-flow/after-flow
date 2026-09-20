import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DeadlineRule } from '../src/domain/task/rule-engine.js'
import { computeDeadline, daysRemaining, severityOf } from '../src/domain/task/rule-engine.js'

/** 業務レビュー済みという前提の架空ルール。実際の法定期限ではない。 */
function reviewedRule(overrides: Partial<DeadlineRule> = {}): DeadlineRule {
  return {
    id: 'fixture-rule',
    version: '1.0.0',
    label: '架空の手続き期限',
    basis: 'KNOWN_AT',
    offsetDays: 7,
    jurisdiction: '架空市',
    reviewed: true,
    sourceUrl: 'https://example.test/fixture',
    sourceCheckedAt: '2026-09-20T00:00:00+09:00',
    extendable: false,
    critical: true,
    ...overrides,
  }
}

describe('期限の算定', () => {
  it('日数の加算で期限を出す', () => {
    const result = computeDeadline(reviewedRule(), { dateOfDeath: '2026-04-01', knownAt: '2026-04-03' })
    assert.equal(result.startDate, '2026-04-03')
    assert.equal(result.dueDate, '2026-04-10')
    assert.equal(result.unresolvedReason, null)
  })

  it('起算日の種類で使う日付が変わる', () => {
    const dates = { dateOfDeath: '2026-04-01', knownAt: '2026-04-20' }
    const fromDeath = computeDeadline(reviewedRule({ basis: 'DATE_OF_DEATH' }), dates)
    const fromKnown = computeDeadline(reviewedRule({ basis: 'KNOWN_AT' }), dates)

    assert.equal(fromDeath.dueDate, '2026-04-08')
    assert.equal(fromKnown.dueDate, '2026-04-27')
    assert.match(fromDeath.basisLabel, /死亡日/)
    assert.match(fromKnown.basisLabel, /知った日/)
  })

  it('月をまたぐ加算を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ offsetDays: 7 }), {
      dateOfDeath: null,
      knownAt: '2026-04-28',
    })
    assert.equal(result.dueDate, '2026-05-05')
  })

  it('年をまたぐ加算を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ offsetDays: 10 }), {
      dateOfDeath: null,
      knownAt: '2026-12-28',
    })
    assert.equal(result.dueDate, '2027-01-07')
  })

  it('閏年の2月を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ offsetDays: 1 }), {
      dateOfDeath: null,
      knownAt: '2028-02-28',
    })
    assert.equal(result.dueDate, '2028-02-29')
  })

  it('月単位の加算で応当日が無い場合は末日にする', () => {
    // 繰り上げて翌月にすると、期限が実際より後になる。
    const result = computeDeadline(reviewedRule({ offsetDays: undefined, offsetMonths: 1 }), {
      dateOfDeath: null,
      knownAt: '2026-01-31',
    })
    assert.equal(result.dueDate, '2026-02-28')
  })

  it('3か月の加算で年をまたぐ', () => {
    const result = computeDeadline(reviewedRule({ offsetDays: undefined, offsetMonths: 3 }), {
      dateOfDeath: null,
      knownAt: '2026-11-30',
    })
    assert.equal(result.dueDate, '2027-02-28')
  })

  it('起算日が未入力なら期限を出さない', () => {
    const result = computeDeadline(reviewedRule({ basis: 'KNOWN_AT' }), {
      dateOfDeath: '2026-04-01',
      knownAt: null,
    })
    // 不明な起算日を死亡日で補完しない。
    assert.equal(result.dueDate, null)
    assert.equal(result.startDate, null)
    assert.equal(result.unresolvedReason, 'MISSING_BASIS_DATE')
  })

  it('存在しない日付を起算日にしない', () => {
    const result = computeDeadline(reviewedRule(), { dateOfDeath: null, knownAt: '2026-02-30' })
    assert.equal(result.dueDate, null)
    assert.equal(result.unresolvedReason, 'MISSING_BASIS_DATE')
  })

  it('業務レビュー未了のルールから期限を出さない', () => {
    const result = computeDeadline(reviewedRule({ reviewed: false }), {
      dateOfDeath: null,
      knownAt: '2026-04-03',
    })
    assert.equal(result.dueDate, null)
    assert.equal(result.unresolvedReason, 'RULE_UNCONFIRMED')
    // 根拠の説明自体は出す。何を待っているかが分かるようにする。
    assert.match(result.basisLabel, /知った日/)
  })
})

describe('残日数と重大度', () => {
  it('期限が無ければ残日数も出さない', () => {
    assert.equal(daysRemaining(null, '2026-04-10'), null)
    assert.equal(severityOf(null), null)
  })

  it('同じ日なら 0 日', () => {
    assert.equal(daysRemaining('2026-04-10', '2026-04-10'), 0)
  })

  it('期限を過ぎていれば負になる', () => {
    assert.equal(daysRemaining('2026-04-10', '2026-04-12'), -2)
    assert.equal(severityOf(-2), 'OVERDUE')
  })

  it('月と年をまたいでも日数が合う', () => {
    assert.equal(daysRemaining('2027-01-01', '2026-12-25'), 7)
  })

  it('残日数から重大度を決める', () => {
    assert.equal(severityOf(0), 'URGENT')
    assert.equal(severityOf(3), 'URGENT')
    assert.equal(severityOf(4), 'SOON')
    assert.equal(severityOf(14), 'SOON')
    assert.equal(severityOf(15), 'NORMAL')
  })
})
