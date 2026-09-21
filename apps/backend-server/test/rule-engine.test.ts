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
    period: { unit: 'DAY', count: 7, includeFirstDay: false },
    basisLabel: '相続の開始を知った日の翌日から数えて7日以内',
    legalNature: 'JURISDICTIONAL',
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
    const fromDeath = computeDeadline(
      reviewedRule({ basis: 'DATE_OF_DEATH', basisLabel: '亡くなった日の翌日から数えて7日以内' }),
      dates,
    )
    const fromKnown = computeDeadline(reviewedRule({ basis: 'KNOWN_AT' }), dates)

    assert.equal(fromDeath.dueDate, '2026-04-08')
    assert.equal(fromKnown.dueDate, '2026-04-27')
    assert.match(fromDeath.basisLabel, /亡くなった日/)
    assert.match(fromKnown.basisLabel, /知った日/)
  })

  it('月をまたぐ加算を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ period: { unit: 'DAY', count: 7, includeFirstDay: false } }), {
      dateOfDeath: null,
      knownAt: '2026-04-28',
    })
    assert.equal(result.dueDate, '2026-05-05')
  })

  it('年をまたぐ加算を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ period: { unit: 'DAY', count: 10, includeFirstDay: false } }), {
      dateOfDeath: null,
      knownAt: '2026-12-28',
    })
    assert.equal(result.dueDate, '2027-01-07')
  })

  it('閏年の2月を正しく扱う', () => {
    const result = computeDeadline(reviewedRule({ period: { unit: 'DAY', count: 1, includeFirstDay: false } }), {
      dateOfDeath: null,
      knownAt: '2028-02-28',
    })
    assert.equal(result.dueDate, '2028-02-29')
  })

  it('月単位の加算で応当日が無い場合は末日にする', () => {
    // 繰り上げて翌月にすると、期限が実際より後になる。
    const result = computeDeadline(reviewedRule({ period: { unit: 'MONTH', count: 1, includeFirstDay: false } }), {
      dateOfDeath: null,
      knownAt: '2026-01-31',
    })
    assert.equal(result.dueDate, '2026-02-28')
  })

  it('3か月の加算で年をまたぐ', () => {
    const result = computeDeadline(reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: false } }), {
      dateOfDeath: null,
      knownAt: '2026-11-30',
    })
    assert.equal(result.dueDate, '2027-02-28')
  })

  it('KNOWN_AT が未入力なら死亡日で代わりに算定し、その旨を付記する', () => {
    const result = computeDeadline(reviewedRule({ basis: 'KNOWN_AT' }), {
      dateOfDeath: '2026-04-01',
      knownAt: null,
    })
    assert.equal(result.startDate, '2026-04-01')
    assert.equal(result.dueDate, '2026-04-08')
    assert.equal(result.unresolvedReason, null)
    assert.ok(result.basisLabel.endsWith('（相続の開始を知った日が未入力のため、亡くなった日から数えています）'))
  })

  it('両方の起算日が未入力なら期限を出さない', () => {
    const result = computeDeadline(reviewedRule({ basis: 'KNOWN_AT' }), {
      dateOfDeath: null,
      knownAt: null,
    })
    assert.equal(result.dueDate, null)
    assert.equal(result.startDate, null)
    assert.equal(result.unresolvedReason, 'MISSING_BASIS_DATE')
  })

  it('DATE_OF_DEATH のルールは死亡日が未入力でも知った日で代わりに算定しない', () => {
    const result = computeDeadline(
      reviewedRule({ basis: 'DATE_OF_DEATH', basisLabel: '亡くなった日の翌日から数えて7日以内' }),
      { dateOfDeath: null, knownAt: '2026-04-20' },
    )
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
    // ルールの文言をそのまま返す。機械生成しない。
    assert.equal(result.basisLabel, reviewedRule().basisLabel)
  })

  it('業務レビュー未了かつ起算日が未入力でも、フォールバック後の起算日は返す', () => {
    const result = computeDeadline(reviewedRule({ basis: 'KNOWN_AT', reviewed: false }), {
      dateOfDeath: '2026-04-01',
      knownAt: null,
    })
    assert.equal(result.startDate, '2026-04-01')
    assert.equal(result.dueDate, null)
    assert.equal(result.unresolvedReason, 'RULE_UNCONFIRMED')
  })

  it('count が正の整数でなければ内部エラーにする', () => {
    assert.throws(() =>
      computeDeadline(reviewedRule({ period: { unit: 'DAY', count: 0, includeFirstDay: false } }), {
        dateOfDeath: null,
        knownAt: '2026-04-01',
      }),
    )
  })
})

describe('法律の数え方（申し送り3-3）', () => {
  it('民法140条: 初日不算入。9/15から14日以内は9/29', () => {
    const result = computeDeadline(
      reviewedRule({ basis: 'DATE_OF_DEATH', period: { unit: 'DAY', count: 14, includeFirstDay: false } }),
      { dateOfDeath: '2026-09-15', knownAt: null },
    )
    assert.equal(result.dueDate, '2026-09-29')
  })

  it('民法143条: 暦で数える。9/15から3か月は12/15', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2026-09-15' },
    )
    assert.equal(result.dueDate, '2026-12-15')
  })

  it('民法143条2項ただし書: 応当日が無ければ末日。8/31から3か月は11/30', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2026-08-31' },
    )
    assert.equal(result.dueDate, '2026-11-30')
  })

  it('起算日が月の初日になる場合でも143条1項どおりに数える（4/30から3か月は7/31）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2026-04-30' },
    )
    assert.equal(result.dueDate, '2026-07-31')
  })

  it('起算日が月の初日になる場合でも143条1項どおりに数える（9/30から3か月は12/31）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2026-09-30' },
    )
    assert.equal(result.dueDate, '2026-12-31')
  })

  it('起算日が月の初日になる場合でも143条1項どおりに数える（平年2/28から1か月は3/31）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 1, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2027-02-28' },
    )
    assert.equal(result.dueDate, '2027-03-31')
  })

  it('起算日が月の初日になる場合でも143条1項どおりに数える（閏年2/29から1か月は3/31）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 1, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2028-02-29' },
    )
    assert.equal(result.dueDate, '2028-03-31')
  })

  it('戸籍法43条: 初日算入。死亡届は知った日を含めて7日以内（9/15から9/21）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'DAY', count: 7, includeFirstDay: true } }),
      { dateOfDeath: null, knownAt: '2026-09-15' },
    )
    assert.equal(result.dueDate, '2026-09-21')
  })

  it('YEAR単位: 3年は暦年で数える（9/15から3年後は9/15）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'YEAR', count: 3, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2026-09-15' },
    )
    assert.equal(result.dueDate, '2029-09-15')
  })

  it('YEAR単位: 閏日の翌日3/1が起算日なら応当日3/1の前日で満了する（2028-02-29から1年後は2029-02-28）', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'YEAR', count: 1, includeFirstDay: false } }),
      { dateOfDeath: null, knownAt: '2028-02-29' },
    )
    assert.equal(result.dueDate, '2029-02-28')
  })

  it('初日算入かつ月単位: 9/15から3か月(初日算入)は12/14', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: true } }),
      { dateOfDeath: null, knownAt: '2026-09-15' },
    )
    assert.equal(result.dueDate, '2026-12-14')
  })

  it('初日算入かつ月単位で応当日が無い場合は末日: 11/30から3か月(初日算入)は2027-02-28', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: true } }),
      { dateOfDeath: null, knownAt: '2026-11-30' },
    )
    assert.equal(result.dueDate, '2027-02-28')
  })

  it('初日算入かつ起算日が月の初日: 5/1から3か月(初日算入)は7/31', () => {
    const result = computeDeadline(
      reviewedRule({ period: { unit: 'MONTH', count: 3, includeFirstDay: true } }),
      { dateOfDeath: null, knownAt: '2026-05-01' },
    )
    assert.equal(result.dueDate, '2026-07-31')
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
