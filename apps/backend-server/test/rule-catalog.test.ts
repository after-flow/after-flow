import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { computeDeadline, MAX_INITIAL_PROCEDURES } from '../src/domain/task/rule-engine.js'
import type { DeadlineRule, InitialProcedure, RuleCatalog } from '../src/domain/task/rule-engine.js'
import { PLACEHOLDER_RULE_CATALOG } from '../src/domain/task/rule-catalog.js'
import { assertRuleCatalogUsable, readRuleCatalog } from '../src/infrastructure/rules/rule-config.js'
import { PRODUCTION_MIN_CATALOG, PRODUCTION_REVIEWER, PRODUCTION_REVIEWED_AT } from './helpers/production-catalog-fixture.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const EXAMPLE_JSON_PATH = path.join(__dirname, '..', '..', '..', 'infra', 'rules', 'deadline-rules.example.json')

function ruleOf(id: string) {
  const rule = PLACEHOLDER_RULE_CATALOG.deadlineRules.find((candidate) => candidate.id === id)
  assert.ok(rule, `${id} が見つからない`)
  return rule
}

function procedureOf(id: string) {
  const procedure = PLACEHOLDER_RULE_CATALOG.initialProcedures.find((candidate) => candidate.id === id)
  assert.ok(procedure, `${id} が見つからない`)
  return procedure
}

describe('PLACEHOLDER_RULE_CATALOG', () => {
  it('カタログ自体の検証を通る', () => {
    assert.doesNotThrow(() => assertRuleCatalogUsable(PLACEHOLDER_RULE_CATALOG))
  })

  it('27手続き・17期限ルールを持つ', () => {
    assert.equal(PLACEHOLDER_RULE_CATALOG.initialProcedures.length, 27)
    assert.equal(PLACEHOLDER_RULE_CATALOG.deadlineRules.length, 17)
  })

  it('reviewed:trueのルールはすべてSTATUTORYで、根拠URLと確認日時とreviewerを持つ', () => {
    for (const rule of PLACEHOLDER_RULE_CATALOG.deadlineRules) {
      if (!rule.reviewed) continue
      assert.equal(rule.legalNature, 'STATUTORY', `${rule.id} は placeholder で reviewed にできない`)
      assert.ok(rule.sourceUrl, `${rule.id} に sourceUrl が無い`)
      assert.ok(rule.sourceCheckedAt, `${rule.id} に sourceCheckedAt が無い`)
      assert.ok(rule.reviewedBy, `${rule.id} に reviewedBy が無い`)
    }
  })

  it('national-health-insurance-loss は死亡を名指しした条文が無いため reviewed:false のまま', () => {
    const rule = ruleOf('national-health-insurance-loss')
    assert.equal(rule.reviewed, false)
    assert.equal(rule.reviewedBy, null)
  })

  it('KNOWN_AT のルールは knownAtLabel を持ち、DATE_OF_DEATH のルールは持たない', () => {
    for (const rule of PLACEHOLDER_RULE_CATALOG.deadlineRules) {
      if (rule.basis === 'KNOWN_AT') assert.ok(rule.knownAtLabel, `${rule.id} に knownAtLabel が無い`)
      else assert.equal(rule.knownAtLabel, null, `${rule.id} は DATE_OF_DEATH なのに knownAtLabel を持つ`)
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

  it('年金の受給停止: 厚生年金は死亡日の翌日から10日、国民年金は14日', () => {
    const employees = computeDeadline(ruleOf('pension-stop-employees'), { dateOfDeath: '2026-09-15', knownAt: null })
    assert.equal(employees.dueDate, '2026-09-25')
    const national = computeDeadline(ruleOf('pension-stop-national'), { dateOfDeath: '2026-09-15', knownAt: null })
    assert.equal(national.dueDate, '2026-09-29')
  })

  it('準確定申告: 知った日の翌日から4か月（9/15知った日 → 1/15）', () => {
    const result = computeDeadline(ruleOf('final-income-tax-return'), { dateOfDeath: null, knownAt: '2026-09-15' })
    assert.equal(result.dueDate, '2027-01-15')
  })

  it('相続税の申告: 知った日の翌日から10か月（9/15知った日 → 7/15）', () => {
    const result = computeDeadline(ruleOf('inheritance-tax-return'), { dateOfDeath: null, knownAt: '2026-09-15' })
    assert.equal(result.dueDate, '2027-07-15')
  })

  it('相続登記: 知った日から3年', () => {
    const result = computeDeadline(ruleOf('real-estate-registration'), { dateOfDeath: null, knownAt: '2026-09-15' })
    assert.equal(result.dueDate, '2029-09-15')
  })

  it('profile 未回答の新規Caseでは22件の手続きが対象になる（default no の5件を除く）', () => {
    const noByDefault = PLACEHOLDER_RULE_CATALOG.initialProcedures.filter(
      (procedure) => procedure.applicability.default === 'no' && procedure.applicability.rules.length > 0,
    )
    assert.equal(noByDefault.length, 5)
    assert.equal(PLACEHOLDER_RULE_CATALOG.initialProcedures.length - noByDefault.length, 22)
  })

  it('targetDate は will-check / collect-family-register / estate-survey の3件だけに付く', () => {
    const withTargetDate = PLACEHOLDER_RULE_CATALOG.initialProcedures.filter((procedure) => procedure.targetDate !== null)
    assert.deepEqual(withTargetDate.map((p) => p.id).sort(), ['collect-family-register', 'estate-survey', 'will-check'])
  })

  it('example.json は assertRuleCatalogUsable を通り、procedure id 集合と deadlineRule id 集合が TS と一致する', () => {
    const example = JSON.parse(readFileSync(EXAMPLE_JSON_PATH, 'utf8')) as RuleCatalog
    assert.doesNotThrow(() => assertRuleCatalogUsable(example))
    assert.deepEqual(
      new Set(example.initialProcedures.map((p) => p.id)),
      new Set(PLACEHOLDER_RULE_CATALOG.initialProcedures.map((p) => p.id)),
    )
    assert.deepEqual(
      new Set(example.deadlineRules.map((r) => r.id)),
      new Set(PLACEHOLDER_RULE_CATALOG.deadlineRules.map((r) => r.id)),
    )
  })
})

describe('assertRuleCatalogUsable', () => {
  const baseRule = ruleOf('death-notification')
  const baseProcedure = procedureOf('death-notification')

  function catalogWith(overrides: Partial<DeadlineRule>, placeholder = true): RuleCatalog {
    return {
      placeholder,
      deadlineRules: [{ ...baseRule, ...overrides }],
      initialProcedures: [],
      deliberationDeadlineRuleId: null,
      reviewedBy: null,
      reviewedAt: null,
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

  it('KNOWN_AT のルールに knownAtLabel が無ければ拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ knownAtLabel: null })))
  })

  it('DATE_OF_DEATH のルールに knownAtLabel があれば拒否する', () => {
    assert.throws(() =>
      assertRuleCatalogUsable(catalogWith({ basis: 'DATE_OF_DEATH', reviewed: false, knownAtLabel: '知った日' })),
    )
  })

  it('reviewed:true なのに reviewedBy が無ければ拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({ reviewedBy: null })))
  })

  it('reviewedBy.qualification が不正なら拒否する', () => {
    assert.throws(() =>
      assertRuleCatalogUsable(
        catalogWith({ reviewedBy: { name: 'x', qualification: 'OTHER' as never } }),
      ),
    )
  })

  it('placeholder:false で reviewedBy が ENGINEER なら拒否する（3-5）', () => {
    assert.throws(() =>
      assertRuleCatalogUsable(
        {
          ...catalogWith({}, false),
          reviewedBy: PRODUCTION_REVIEWER,
          reviewedAt: PRODUCTION_REVIEWED_AT,
        },
      ),
    )
  })

  it('placeholder:false でカタログ自体の reviewedBy が無ければ拒否する', () => {
    assert.throws(() => assertRuleCatalogUsable(catalogWith({}, false)))
  })

  it('placeholder:false で PRODUCTION_MIN_CATALOG（reviewedBy/reviewedAt 付き）は通る', () => {
    assert.doesNotThrow(() => assertRuleCatalogUsable(PRODUCTION_MIN_CATALOG))
  })

  it('初期手続きの件数がMAX_INITIAL_PROCEDURESを超えると拒否する', () => {
    const procedures: InitialProcedure[] = Array.from({ length: MAX_INITIAL_PROCEDURES + 1 }, (_, index) => ({
      ...baseProcedure,
      id: `over-${index}`,
      deadlineRuleId: null,
    }))
    assert.throws(() =>
      assertRuleCatalogUsable({
        placeholder: true,
        deadlineRules: [],
        initialProcedures: procedures,
        deliberationDeadlineRuleId: null,
        reviewedBy: null,
        reviewedAt: null,
      }),
    )
  })

  it('applicability/variants/targetDateが欠落した手続きを拒否する', () => {
    const { applicability: _applicability, ...withoutApplicability } = { ...baseProcedure, deadlineRuleId: null }
    assert.throws(() =>
      assertRuleCatalogUsable({
        placeholder: true,
        deadlineRules: [],
        initialProcedures: [withoutApplicability as InitialProcedure],
        deliberationDeadlineRuleId: null,
        reviewedBy: null,
        reviewedAt: null,
      }),
    )
  })

  function catalogWithProcedure(procedure: InitialProcedure): RuleCatalog {
    return {
      placeholder: true,
      deadlineRules: [baseRule],
      initialProcedures: [procedure],
      deliberationDeadlineRuleId: null,
      reviewedBy: null,
      reviewedAt: null,
    }
  }

  it('条件のfieldがPROFILE_FIELDS外なら拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      applicability: { default: 'no', rules: [{ when: { field: 'unknownField' as never, in: ['X'] }, include: 'yes' }] },
    }
    assert.throws(() => assertRuleCatalogUsable(catalogWithProcedure(procedure)))
  })

  it('条件のinの値がPROFILE_VALUES外なら拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      applicability: { default: 'no', rules: [{ when: { field: 'pension', in: ['NOT_A_VALUE'] }, include: 'yes' }] },
    }
    assert.throws(() => assertRuleCatalogUsable(catalogWithProcedure(procedure)))
  })

  it('条件のinが空配列なら拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      applicability: { default: 'no', rules: [{ when: { field: 'pension', in: [] }, include: 'yes' }] },
    }
    assert.throws(() => assertRuleCatalogUsable(catalogWithProcedure(procedure)))
  })

  it('all/anyが空配列なら拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      applicability: { default: 'no', rules: [{ when: { all: [] }, include: 'yes' }] },
    }
    assert.throws(() => assertRuleCatalogUsable(catalogWithProcedure(procedure)))
  })

  it('variantが参照するdeadlineRuleIdがカタログに無ければ拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      variants: [{ when: { field: 'pension', in: ['NONE'] }, deadlineRuleId: 'no-such-rule' }],
    }
    assert.throws(() => assertRuleCatalogUsable(catalogWithProcedure(procedure)))
  })

  it('targetDateがあるのにdeliberationDeadlineRuleIdが無ければ拒否する', () => {
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      targetDate: { monthsBeforeDeliberationDeadline: 1, basisLabel: '目安' },
    }
    assert.throws(() =>
      assertRuleCatalogUsable({ ...catalogWithProcedure(procedure), deliberationDeadlineRuleId: null }),
    )
  })

  it('熟慮期間ルールのperiod.unitがDAYならtargetDateを拒否する', () => {
    const dayRule: DeadlineRule = { ...baseRule, id: 'day-rule', period: { unit: 'DAY', count: 90, includeFirstDay: false } }
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      targetDate: { monthsBeforeDeliberationDeadline: 1, basisLabel: '目安' },
    }
    assert.throws(() =>
      assertRuleCatalogUsable({
        placeholder: true,
        deadlineRules: [dayRule],
        initialProcedures: [procedure],
        deliberationDeadlineRuleId: 'day-rule',
        reviewedBy: null,
        reviewedAt: null,
      }),
    )
  })

  it('targetDateの月数が熟慮期間の月数以上なら拒否する', () => {
    const threeMonthRule: DeadlineRule = { ...baseRule, id: 'three-month', period: { unit: 'MONTH', count: 3, includeFirstDay: false } }
    const procedure: InitialProcedure = {
      ...baseProcedure,
      deadlineRuleId: null,
      targetDate: { monthsBeforeDeliberationDeadline: 3, basisLabel: '目安' },
    }
    assert.throws(() =>
      assertRuleCatalogUsable({
        placeholder: true,
        deadlineRules: [threeMonthRule],
        initialProcedures: [procedure],
        deliberationDeadlineRuleId: 'three-month',
        reviewedBy: null,
        reviewedAt: null,
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
    writeFileSync(file, JSON.stringify(PRODUCTION_MIN_CATALOG))
    const catalog = readRuleCatalog({ DEADLINE_RULES_PATH: file })
    assert.equal(catalog.deliberationDeadlineRuleId, null)
  })

  it('承認済みの正式カタログはNODE_ENV=productionでも読み込める', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-rule-catalog-'))
    const file = path.join(dir, 'rules.json')
    writeFileSync(file, JSON.stringify(PRODUCTION_MIN_CATALOG))
    const catalog = readRuleCatalog({ NODE_ENV: 'production', DEADLINE_RULES_PATH: file })
    assert.equal(catalog.placeholder, false)
  })
})
