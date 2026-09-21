import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { computeDeadline } from '../src/domain/task/rule-engine.js'
import type { RuleCatalog } from '../src/domain/task/rule-engine.js'
import { PLACEHOLDER_RULE_CATALOG } from '../src/domain/task/rule-catalog.js'
import { assertRuleCatalogUsable, readRuleCatalog } from '../src/infrastructure/rules/rule-config.js'

function ruleOf(id: string) {
  const rule = PLACEHOLDER_RULE_CATALOG.deadlineRules.find((candidate) => candidate.id === id)
  assert.ok(rule, `${id} が見つからない`)
  return rule
}

describe('PLACEHOLDER_RULE_CATALOG', () => {
  it('カタログ自体の検証を通る', () => {
    assert.doesNotThrow(() => assertRuleCatalogUsable(PLACEHOLDER_RULE_CATALOG))
  })

  it('reviewed:trueのルールはすべてSTATUTORYで、根拠URLと確認日時を持つ', () => {
    for (const rule of PLACEHOLDER_RULE_CATALOG.deadlineRules) {
      if (!rule.reviewed) continue
      assert.equal(rule.legalNature, 'STATUTORY', `${rule.id} は placeholder で reviewed にできない`)
      assert.ok(rule.sourceUrl, `${rule.id} に sourceUrl が無い`)
      assert.ok(rule.sourceCheckedAt, `${rule.id} に sourceCheckedAt が無い`)
    }
  })

  it('deliberationDeadlineRuleId が参照するルールが存在する', () => {
    assert.ok(PLACEHOLDER_RULE_CATALOG.deliberationDeadlineRuleId)
    const ids = new Set(PLACEHOLDER_RULE_CATALOG.deadlineRules.map((rule) => rule.id))
    assert.ok(ids.has(PLACEHOLDER_RULE_CATALOG.deliberationDeadlineRuleId!))
  })

  it('死亡届: 戸籍法43条の初日算入で、知った日を含めて7日以内', () => {
    const result = computeDeadline(ruleOf('death-notification'), { dateOfDeath: null, knownAt: '2026-09-15' })
    assert.equal(result.dueDate, '2026-09-21')
    assert.equal(result.unresolvedReason, null)
  })

  it('相続方法の選択: 民法915条・143条どおりの3か月', () => {
    const onSeptember = computeDeadline(ruleOf('inheritance-choice'), { dateOfDeath: null, knownAt: '2026-09-15' })
    assert.equal(onSeptember.dueDate, '2026-12-15')
    const onMonthEnd = computeDeadline(ruleOf('inheritance-choice'), { dateOfDeath: null, knownAt: '2026-08-31' })
    assert.equal(onMonthEnd.dueDate, '2026-11-30')
  })
})

describe('assertRuleCatalogUsable', () => {
  const baseRule = ruleOf('death-notification')

  function catalogWith(overrides: Partial<RuleCatalog['deadlineRules'][number]>, placeholder = true): RuleCatalog {
    return {
      placeholder,
      deadlineRules: [{ ...baseRule, ...overrides }],
      initialProcedures: [],
      deliberationDeadlineRuleId: null,
    }
  }

  it('placeholderカタログでreviewedなJURISDICTIONALルールを拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ legalNature: 'JURISDICTIONAL' })))
  })

  it('reviewed:trueなのにsourceCheckedAtが無いルールを拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ sourceCheckedAt: null })))
  })

  it('reviewed:trueなのにsourceUrlが無いルールを拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ sourceUrl: null })))
  })

  it('period.countが0のルールを拒否する', () => {
    assert.throws(() =>
      assertRuleCatalogUsable(catalogWith({ period: { unit: 'DAY', count: 0, includeFirstDay: false } })),
    )
  })

  it('period.countが整数でないルールを拒否する', () => {
    assert.throws(() =>
      assertRuleCatalogUsable(catalogWith({ period: { unit: 'DAY', count: 1.5, includeFirstDay: false } })),
    )
  })

  it('basisLabelが空のルールを拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ basisLabel: '' })))
  })

  it('未知のdeliberationDeadlineRuleIdを拒否する', () => {
    assert.throws(() =>
      assertRuleCatalogUsable({
        placeholder: false,
        deadlineRules: [baseRule],
        initialProcedures: [],
        deliberationDeadlineRuleId: 'unknown-rule',
      }),
    )
  })

  it('STATUTORYで根拠が揃っていればplaceholderでも通る', () => {
    assert.doesNotThrow(() => assertRuleCatalogUsable(catalogWith({})))
  })
})

describe('readRuleCatalog', () => {
  it('DEADLINE_RULES_PATH未設定・NODE_ENV未設定ならplaceholderを返す', () => {
    const catalog = readRuleCatalog({})
    assert.equal(catalog.placeholder, true)
  })

  it('DEADLINE_RULES_PATH未設定・NODE_ENV=productionなら起動できない', () => {
    assert.throws(() => readRuleCatalog({ NODE_ENV: 'production' }))
  })

  it('placeholder:trueのファイルを指していてもNODE_ENV=productionなら拒否する', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-rule-catalog-'))
    const file = path.join(dir, 'rules.json')
    writeFileSync(
      file,
      JSON.stringify({ placeholder: true, deadlineRules: [], initialProcedures: [], deliberationDeadlineRuleId: null }),
    )
    assert.throws(() => readRuleCatalog({ NODE_ENV: 'production', DEADLINE_RULES_PATH: file }))
  })

  it('placeholderを省略したファイルは本番以外でも拒否する', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-rule-catalog-'))
    const file = path.join(dir, 'rules.json')
    writeFileSync(file, JSON.stringify({ deadlineRules: [], initialProcedures: [], deliberationDeadlineRuleId: null }))
    assert.throws(() => readRuleCatalog({ DEADLINE_RULES_PATH: file }), /placeholder/)
  })

  it('deliberationDeadlineRuleIdを省略したファイルはnull扱いになる', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-rule-catalog-'))
    const file = path.join(dir, 'rules.json')
    writeFileSync(file, JSON.stringify({ placeholder: false, deadlineRules: [], initialProcedures: [] }))
    const catalog = readRuleCatalog({ DEADLINE_RULES_PATH: file })
    assert.equal(catalog.deliberationDeadlineRuleId, null)
  })

  it('承認済みの正式カタログはNODE_ENV=productionでも読み込める', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-rule-catalog-'))
    const file = path.join(dir, 'rules.json')
    writeFileSync(
      file,
      JSON.stringify({ placeholder: false, deadlineRules: [], initialProcedures: [], deliberationDeadlineRuleId: null }),
    )
    const catalog = readRuleCatalog({ NODE_ENV: 'production', DEADLINE_RULES_PATH: file })
    assert.equal(catalog.placeholder, false)
  })
})
