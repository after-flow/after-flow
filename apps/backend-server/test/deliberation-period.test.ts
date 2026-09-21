import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DELIBERATION_DEADLINE_ID, deliberationDeadlineOf } from '../src/domain/decision/deliberation-period.js'
import { toDeadlineView } from '../src/application/task/task-service.js'
import type { DeadlineRule, RuleCatalog } from '../src/domain/task/rule-engine.js'

/** 民法915条という前提の架空ルール。実際の法定期限ではない。 */
function deliberationRule(overrides: Partial<DeadlineRule> = {}): DeadlineRule {
  return {
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
    ...overrides,
  }
}

function catalogOf(rule: DeadlineRule, deliberationDeadlineRuleId: string | null = rule.id): RuleCatalog {
  return {
    placeholder: false,
    deadlineRules: [rule],
    initialProcedures: [],
    deliberationDeadlineRuleId,
    reviewedBy: { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' },
    reviewedAt: '2026-09-20T00:00:00+09:00',
  }
}

describe('熟慮期間の期限（申し送り3-4）', () => {
  it('知った日から算定する', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule()), {
      dateOfDeath: '2026-09-01',
      knownAt: '2026-09-15',
    })
    assert.ok(facts)
    assert.equal(facts.id, DELIBERATION_DEADLINE_ID)
    assert.equal(facts.taskId, null)
    assert.equal(facts.dueDate, '2026-12-15')
    assert.equal(facts.confirmation, 'CONFIRMED')
    assert.equal(facts.critical, true)
    assert.equal(facts.extendable, true)
  })

  it('知った日が未入力なら死亡日で代わりに算定し、付記する', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule()), {
      dateOfDeath: '2026-09-15',
      knownAt: null,
    })
    assert.ok(facts)
    assert.equal(facts.dueDate, '2026-12-15')
    assert.match(facts.basisLabel, /知った日が未入力のため/)
  })

  it('未確認のルールなら日付を出さない', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule({ reviewed: false })), {
      dateOfDeath: '2026-09-01',
      knownAt: '2026-09-15',
    })
    assert.ok(facts)
    assert.equal(facts.confirmation, 'UNCONFIRMED')
    assert.equal(facts.dueDate, null)
  })

  it('カタログに熟慮期間のルールIDが無ければ null', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule(), null), {
      dateOfDeath: '2026-09-01',
      knownAt: '2026-09-15',
    })
    assert.equal(facts, null)
  })

  it('参照先のルールが存在しなければ内部エラー', () => {
    assert.throws(() =>
      deliberationDeadlineOf(catalogOf(deliberationRule(), 'missing-rule'), {
        dateOfDeath: '2026-09-01',
        knownAt: '2026-09-15',
      }),
    )
  })

  it('表示用ビューへの変換で残日数と重大度が付く', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule()), {
      dateOfDeath: '2026-09-01',
      knownAt: '2026-09-15',
    })
    assert.ok(facts)
    assert.equal(facts.dueDate, '2026-12-15')

    assert.deepEqual(
      [toDeadlineView(facts, '2026-12-01').daysRemaining, toDeadlineView(facts, '2026-12-01').severity],
      [14, 'SOON'],
    )
    assert.deepEqual(
      [toDeadlineView(facts, '2026-12-13').daysRemaining, toDeadlineView(facts, '2026-12-13').severity],
      [2, 'URGENT'],
    )
    assert.deepEqual(
      [toDeadlineView(facts, '2026-12-15').daysRemaining, toDeadlineView(facts, '2026-12-15').severity],
      [0, 'URGENT'],
    )
    assert.deepEqual(
      [toDeadlineView(facts, '2026-12-16').daysRemaining, toDeadlineView(facts, '2026-12-16').severity],
      [-1, 'OVERDUE'],
    )
  })

  it('未確認のルールでは残日数・重大度も出さない', () => {
    const facts = deliberationDeadlineOf(catalogOf(deliberationRule({ reviewed: false })), {
      dateOfDeath: '2026-09-01',
      knownAt: '2026-09-15',
    })
    assert.ok(facts)
    const view = toDeadlineView(facts, '2026-12-01')
    assert.equal(view.confirmation, 'UNCONFIRMED')
    assert.equal(view.dueDate, null)
    assert.equal(view.daysRemaining, null)
    assert.equal(view.severity, null)
  })
})
