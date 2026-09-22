import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PROCEDURE_DEFINITIONS, procedureDefinitionSchema, assertProcedureDefinitionsUsable, findProcedureDefinition,
  contextRequirementSchema, guidanceAllowlist, projectGuidanceContext, procedureResearchBrief,
  resolveDependencyTaskIds, missingContextQuestion, guidanceContextAudit, contextKey, CONTEXT_FIELDS, CONTEXT_FIELD_LABELS,
} from '../src/procedure-definitions.js'
import type { GuidanceProjectionSource } from '../src/procedure-definitions.js'
import { planningHistorySchema } from '../src/index.js'

/** Backend の手続きカタログ（27 件）と同じ ID。案内定義はこの全部を持つ。 */
const CATALOG_IDS = [
  'death-notification', 'household-change', 'health-insurance-loss', 'long-term-care-loss', 'pension-stop', 'unpaid-pension-claim',
  'survivor-pension-check', 'death-lump-sum-check', 'funeral-benefit-claim', 'high-cost-medical-check', 'will-check', 'collect-family-register',
  'estate-survey', 'inheritance-choice', 'final-income-tax-return', 'inheritance-tax-return', 'estate-division', 'bank-accounts',
  'real-estate-registration', 'property-tax-representative', 'car-transfer', 'mortgage-insurance-check', 'employer-procedures',
  'self-employed-notification', 'life-insurance-check', 'utilities-contracts', 'id-returns',
]

describe('PROCEDURE_DEFINITIONS', () => {
  it('全件がスキーマを満たし、カタログの 27 手続きと AI テンプレート用の定義を含む', () => {
    for (const def of PROCEDURE_DEFINITIONS) assert.deepEqual(procedureDefinitionSchema.parse(def), def)
    assert.doesNotThrow(() => assertProcedureDefinitionsUsable(PROCEDURE_DEFINITIONS))
    const ids = new Set(PROCEDURE_DEFINITIONS.map(def => def.id))
    for (const id of [...CATALOG_IDS, 'kyoukaikenpo-burial-benefit', 'cremation-permit', 'inheritance-renunciation']) assert.ok(ids.has(id), id)
  })

  it('reviewed なのは既存ハッカソン設定と一致する協会けんぽだけ', () => {
    assert.deepEqual(PROCEDURE_DEFINITIONS.filter(def => def.reviewStatus === 'reviewed').map(def => def.id), ['kyoukaikenpo-burial-benefit'])
  })

  it('全国共通の9手続きは審査済み公式カタログIDへだけ接続する', () => {
    const expected = new Map<string, string>([
      ['pension-stop', 'nenkin-death-procedures'], ['unpaid-pension-claim', 'nenkin-death-procedures'],
      ['survivor-pension-check', 'nenkin-death-procedures'], ['death-lump-sum-check', 'nenkin-death-procedures'],
      ['inheritance-choice', 'inheritance-renunciation'], ['inheritance-renunciation', 'inheritance-renunciation'],
      ['final-income-tax-return', 'final-income-tax-return'], ['inheritance-tax-return', 'inheritance-tax-return'],
      ['real-estate-registration', 'real-estate-registration'],
    ])
    for (const [procedureId, catalogId] of expected) {
      assert.deepEqual(findProcedureDefinition(procedureId)?.guidance.researchScope.sourceCatalogIds, [catalogId])
    }
  })

  it('CONTEXT_FIELD_LABELS は CONTEXT_FIELDS の全 key を網羅する', () => {
    for (const [group, fields] of Object.entries(CONTEXT_FIELDS)) for (const field of fields) assert.ok(CONTEXT_FIELD_LABELS[`${group}.${field}`], `${group}.${field}`)
  })
})

describe('contextRequirementSchema', () => {
  it('未知の field / group を拒否する', () => {
    assert.throws(() => contextRequirementSchema.parse({ group: 'case', field: 'lastAddress', purpose: 'x' }))
    assert.throws(() => contextRequirementSchema.parse({ group: 'case', field: 'deceasedName', purpose: 'x' }))
    assert.throws(() => contextRequirementSchema.parse({ group: 'persons', field: 'name', purpose: 'x' }))
    assert.throws(() => contextRequirementSchema.parse({ group: 'assets', field: 'name', purpose: 'x' }))
    assert.throws(() => contextRequirementSchema.parse({ group: 'income', field: 'kind', purpose: 'x' }))
  })
})

describe('death-notification', () => {
  const def = findProcedureDefinition('death-notification')!
  const baseSource = {
    case: { id: 'case1', version: 3, deceasedName: '山田太郎', dateOfDeath: '2026-09-01', knownAt: '2026-09-02', municipality: '架空市', status: 'ACTIVE' },
    profile: { healthInsurance: 'NATIONAL', pension: 'UNKNOWN' },
    entities: {
      assets: [{ id: 'a1', version: 1, name: '普通預金', kind: 'DEPOSIT', confirmation: { state: 'UNCONFIRMED' } }],
      persons: [{ id: 'p1', version: 1, name: '山田花子', relationshipLabel: '配偶者' }],
      tasks: [{ id: 't1', version: 1, title: 'x', status: 'NOT_STARTED' }],
    },
  } as unknown as GuidanceProjectionSource

  it('Case を最小化し、profile / assets / persons / tasks を content に含めない', () => {
    const projection = projectGuidanceContext(def, baseSource)
    assert.deepEqual(projection.content.case, { id: 'case1', version: 3, municipality: '架空市', knownAt: '2026-09-02' })
    assert.deepEqual(Object.keys(projection.content), ['case'])
    for (const key of ['case.deceasedName', 'assets.name', 'persons.name', 'profile.healthInsurance', 'tasks.status']) assert.ok(projection.droppedKeys.includes(key), key)
    assert.deepEqual(projection.usedKeys, ['case.knownAt', 'case.municipality'])
    assert.deepEqual(projection.missingRequired, [])
  })

  it('optional の knownAt が null でも missingRequired は空、required の municipality が null なら不足になる', () => {
    const optional = projectGuidanceContext(def, { ...baseSource, case: { ...baseSource.case, knownAt: null } })
    assert.deepEqual(optional.usedKeys, ['case.municipality'])
    assert.deepEqual(optional.missingRequired, [])
    const required = projectGuidanceContext(def, { ...baseSource, case: { ...baseSource.case, municipality: null } })
    assert.deepEqual(required.missingRequired.map(contextKey), ['case.municipality'])
  })
})

describe('profile group', () => {
  it('health-insurance-loss は profile.healthInsurance だけを Case の id / version で投影する', () => {
    const def = findProcedureDefinition('health-insurance-loss')!
    const projection = projectGuidanceContext(def, {
      case: { id: 'case1', version: 2, municipality: '架空市', deceasedName: 'PRIVATE' },
      profile: { healthInsurance: 'EMPLOYEE', pension: 'EMPLOYEES', occupation: 'EMPLOYEE', realEstate: 'NO', car: 'NO', mortgage: 'NO', answeredAt: '2026-09-01T00:00:00Z' },
      entities: {},
    })
    assert.deepEqual(projection.content.profile, { id: 'case1', version: 2, healthInsurance: 'EMPLOYEE' })
    assert.ok(projection.droppedKeys.includes('profile.pension'))
    assert.ok(projection.usedKeys.includes('profile.healthInsurance'))
  })

  it('profile が未回答（null）なら required の profile 項目は不足になる', () => {
    const def = findProcedureDefinition('pension-stop')!
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1 }, profile: null, entities: {} })
    assert.equal('profile' in projection.content, false)
    assert.deepEqual(projection.missingRequired.map(contextKey), ['profile.pension'])
  })

  it('profile の UNKNOWN は値として送っても required の回答済みにはしない', () => {
    const def = findProcedureDefinition('pension-stop')!
    const projection = projectGuidanceContext(def, {
      case: { id: 'case1', version: 1 }, profile: { pension: 'UNKNOWN' }, entities: {},
    })
    assert.deepEqual(projection.content.profile, { id: 'case1', version: 1, pension: 'UNKNOWN' })
    assert.deepEqual(projection.usedKeys, [])
    assert.deepEqual(projection.missingRequired.map(contextKey), ['profile.pension'])
  })
})

describe('resolveDependencyTaskIds', () => {
  it('procedureId が一致する Task だけを順序どおり返す', () => {
    const tasks = [
      { id: 't1', procedureId: 'collect-family-register' }, { id: 't2', procedureId: null },
      { id: 't3', procedureId: 'inheritance-choice' }, { id: 't4', procedureId: 'death-notification' },
    ]
    assert.deepEqual(resolveDependencyTaskIds(['collect-family-register', 'inheritance-choice'], tasks), ['t1', 't3'])
    assert.deepEqual(resolveDependencyTaskIds([], tasks), [])
  })
})

describe('kyoukaikenpo-burial-benefit', () => {
  const def = findProcedureDefinition('kyoukaikenpo-burial-benefit')!
  it('専用の3項目だけをCaseから投影する', () => {
    assert.equal(guidanceAllowlist(def).has('case'), true)
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1,
      healthInsuranceBranch: '東京支部', deceasedInsuranceStatus: 'INSURED',
      burialBenefitApplicantStatus: 'LIVELIHOOD_MAINTAINER', municipality: '架空市', deceasedName: 'PRIVATE' }, entities: {} })
    assert.deepEqual(projection.content.case, { id: 'case1', version: 1, healthInsuranceBranch: '東京支部',
      deceasedInsuranceStatus: 'INSURED', burialBenefitApplicantStatus: 'LIVELIHOOD_MAINTAINER' })
    assert.deepEqual(projection.missingRequired, [])
    assert.ok(projection.droppedKeys.includes('case.municipality') && projection.droppedKeys.includes('case.deceasedName'))
    assert.deepEqual(procedureResearchBrief(def).sourceCatalogIds, ['kyoukaikenpo-burial-benefit'])
  })
  it('未入力の正式状態を不足項目として返す', () => {
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1,
      healthInsuranceBranch: null, deceasedInsuranceStatus: 'DEPENDENT', burialBenefitApplicantStatus: null }, entities: {} })
    assert.deepEqual(projection.missingRequired.map(contextKey), [
      'case.healthInsuranceBranch', 'case.burialBenefitApplicantStatus',
    ])
  })
})

describe('inheritance-renunciation', () => {
  it('usedKeys に case.knownAt と管轄判断用の case.municipality が含まれる', () => {
    const def = findProcedureDefinition('inheritance-renunciation')!
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1, knownAt: '2026-09-02', municipality: '架空市' }, entities: {} })
    assert.ok(projection.usedKeys.includes('case.knownAt'))
    assert.ok(projection.usedKeys.includes('case.municipality'))
  })
})

describe('estate-division', () => {
  it('content は case, persons, relationships, assets, liabilities, decisions に限られ、confirmation / state の出自が保たれる', () => {
    const def = findProcedureDefinition('estate-division')!
    const projection = projectGuidanceContext(def, {
      case: { id: 'case1', version: 1, municipality: '架空市' },
      entities: {
        persons: [{ id: 'p1', version: 1, isHeir: true, name: 'PRIVATE' }],
        relationships: [{ id: 'r1', version: 1, fromPersonId: 'p1', toPersonId: 'p2', kind: 'CHILD' }],
        assets: [{ id: 'a1', version: 1, kind: 'DEPOSIT', institution: '架空銀行', name: '普通預金', amount: 100, confirmation: { state: 'CONFIRMED' } }],
        liabilities: [{ id: 'l1', version: 1, amount: 10, confirmation: { state: 'CONFIRMED' } }],
        decisions: [{ id: 'd1', version: 1, personId: 'p1', method: 'SIMPLE_ACCEPTANCE', state: 'CONFIRMED', note: 'PRIVATE' }],
        contracts: [{ id: 'c1', version: 1, kind: 'INSURANCE' }],
      },
    })
    assert.deepEqual(Object.keys(projection.content).sort(), ['assets', 'case', 'decisions', 'liabilities', 'persons', 'relationships'])
    assert.deepEqual(projection.content.case, { id: 'case1', version: 1 })
    assert.deepEqual(Object.keys(projection.content.assets![0]!).sort(), ['amount', 'confirmation', 'id', 'kind', 'version'])
    assert.deepEqual(Object.keys(projection.content.decisions![0]!).sort(), ['id', 'method', 'personId', 'state', 'version'])
    assert.deepEqual(Object.keys(projection.content.relationships![0]!).sort(), ['fromPersonId', 'id', 'kind', 'toPersonId', 'version'])
    assert.equal(JSON.stringify(projection.content).includes('PRIVATE'), false)
  })

  it('confirmation は状態だけを残し、確認者ID・日時・自由記述を落とす', () => {
    const def = findProcedureDefinition('estate-survey')!
    const projection = projectGuidanceContext(def, {
      case: { id: 'case1', version: 1 }, entities: { assets: [{ id: 'a1', version: 1, kind: 'DEPOSIT',
        confirmation: { state: 'CONFIRMED', confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: { type: 'USER', id: 'private-user' }, confirmedVersion: 1, note: 'PRIVATE-NOTE' } }] },
    })
    assert.deepEqual(projection.content.assets?.[0]?.confirmation, { state: 'CONFIRMED' })
    assert.equal(JSON.stringify(projection.content).includes('private-user'), false)
    assert.equal(JSON.stringify(projection.content).includes('PRIVATE-NOTE'), false)
  })
})

describe('bank-accounts', () => {
  const def = findProcedureDefinition('bank-accounts')!
  it('assets.institution は残し、口座名（name）は落とし、Brief には金融機関名も口座情報も入らない', () => {
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1 },
      entities: { assets: [{ id: 'a1', version: 1, kind: 'DEPOSIT', institution: '架空銀行', name: '普通 1234567', amount: 1 }] } })
    const asset = projection.content.assets![0]!
    assert.equal(asset.institution, '架空銀行')
    assert.equal('name' in asset, false)
    const brief = JSON.stringify(procedureResearchBrief(def))
    assert.equal(brief.includes('1234567'), false)
    assert.equal(brief.includes('架空銀行'), false)
  })

  it('資産が 0 件なら assets.kind / assets.institution が不足になり、質問文は値を含まず 200 文字以内', () => {
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1 }, entities: { assets: [] } })
    const missingKeys = projection.missingRequired.map(contextKey)
    assert.ok(missingKeys.includes('assets.kind') && missingKeys.includes('assets.institution'))
    for (const requirement of projection.missingRequired) {
      const question = missingContextQuestion(requirement)
      assert.ok(question.length <= 200)
      assert.ok(question.includes(CONTEXT_FIELD_LABELS[contextKey(requirement)]!))
      assert.equal(question.includes('架空'), false)
    }
  })

  it('required field が別々の資産に分散している場合は同一資産の情報が揃った扱いにしない', () => {
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1 }, entities: {
      assets: [{ id: 'a1', version: 1, kind: 'DEPOSIT' }, { id: 'a2', version: 1, institution: '架空銀行' }],
      persons: [{ id: 'p1', version: 1, isHeir: true }],
      decisions: [{ id: 'd1', version: 1, personId: 'p1', method: 'SIMPLE_ACCEPTANCE', state: 'CONFIRMED' }],
    } })
    assert.deepEqual(projection.missingRequired.map(contextKey), ['assets.kind', 'assets.institution'])
  })
})

describe('guidanceContextAudit', () => {
  it('値を含まずキーだけを返す', () => {
    const def = findProcedureDefinition('death-notification')!
    const projection = projectGuidanceContext(def, { case: { id: 'case1', version: 1, municipality: '架空市', knownAt: '2026-09-02' }, entities: {} })
    const audit = guidanceContextAudit(def, projection)
    assert.equal(JSON.stringify(audit).includes('架空市'), false)
    assert.deepEqual(audit, { procedureId: 'death-notification', procedureVersion: 1, reviewStatus: 'draft',
      contextKeys: ['case.knownAt', 'case.municipality'], missingRequiredKeys: [], droppedKeys: [] })
  })
})

describe('planningHistorySchema', () => {
  it('targetProcedureId を省略した履歴項目を受理し null を既定値にする', () => {
    const payloadHash = 'A'.repeat(43)
    const history = planningHistorySchema.parse({
      complete: true,
      proposals: [{ id: 'prop1', actionId: null, proposalVersion: 1, payloadHash, status: 'SUBMITTED', kind: 'TASK_PROPOSAL', source: 'AI',
        title: 't', summary: 's', targetTitle: null, targetTaskId: null, assetDisposal: false, supersedesProposalVersion: null }],
      versions: [{ proposalId: 'prop1', proposalVersion: 1, payloadHash, title: 't', summary: 's', targetTitle: null, supersedesProposalVersion: null }],
      approvals: [],
    })
    assert.equal(history.proposals[0]!.targetProcedureId, null)
    assert.equal(history.versions[0]!.targetProcedureId, null)
  })
})
