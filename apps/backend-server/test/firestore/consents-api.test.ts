import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import type { ConsentCatalog } from '../../src/domain/consent/consent.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import { readConsentCatalog } from '../../src/infrastructure/consent/catalog-config.js'
import { buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import { describeFirestore, firestore, newTenantId } from './helpers/emulator.js'

const TERMS = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'TERMS')!
const PRIVACY = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'PRIVACY')!
const CROSS_BORDER = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'CROSS_BORDER_AI')!

const requiredAgreements = [
  { kind: TERMS.kind, version: TERMS.version },
  { kind: PRIVACY.kind, version: PRIVACY.version },
]

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

async function setup(catalog?: ConsentCatalog) {
  const tenantId = newTenantId()
  const userId = 'user-1'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, catalog ? { catalog } : {})
  return { tenantId, userId, app }
}

describeFirestore('同意状態の取得', () => {
  it('未同意でも同意文書と不足を取得できる', async () => {
    const { app } = await setup()
    const response = await call(app, '/consents')

    assert.equal(response.status, 200)
    assert.equal(response.body.data.outstanding, true)
    assert.equal(response.body.data.documents.length, 3)
    assert.deepEqual(response.body.data.availability.missingRequired.sort(), ['PRIVACY', 'TERMS'])
    assert.equal(response.body.data.availability.manualManagement, false)
    assert.equal(response.body.data.availability.externalAi, false)
  })

  it('同意を取るための API は必須同意が無くても使える', async () => {
    const { app } = await setup()
    // ここが塞がると、利用者は未同意の状態から復旧できない。
    assert.equal((await call(app, '/consents')).status, 200)
    const agreed = await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0001'),
    )
    assert.equal(agreed.status, 200)
  })
})

describeFirestore('同意の記録', () => {
  it('必須同意を記録すると手動管理が使えるようになる', async () => {
    const { app } = await setup()
    const agreed = await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0002'),
    )

    assert.equal(agreed.status, 200)
    assert.equal(agreed.body.data.outstanding, false)
    assert.equal(agreed.body.data.availability.manualManagement, true)
    // 任意の外部AI同意はまだ無い。
    assert.equal(agreed.body.data.availability.externalAi, false)
    assert.deepEqual(agreed.body.data.availability.missingOptional, ['CROSS_BORDER_AI'])

    const terms = agreed.body.data.documents.find((d: { kind: string }) => d.kind === 'TERMS')
    assert.equal(terms.satisfied, true)
    assert.equal(terms.agreedVersion, TERMS.version)
    // 同意時刻はサーバーが決める。
    assert.ok(Date.parse(terms.agreedAt) > 0)
  })

  it('表示していない版への同意を拒否する', async () => {
    const { app } = await setup()
    const response = await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: [{ kind: 'TERMS', version: '9.9.9' }] }, 'idem-agree-0003'),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'CONFLICT')
    assert.equal(response.body.error.details.currentVersion, TERMS.version)
  })

  it('同じ要求の再送で履歴が重複しない', async () => {
    const { tenantId, app } = await setup()
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0004'))
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0004'))

    const records = await firestore().collection(`tenants/${tenantId}/consents`).get()
    assert.equal(records.size, 2)
    for (const record of records.docs) {
      assert.equal(record.get('history').length, 1)
    }
  })

  it('存在しない種別を拒否する', async () => {
    const { app } = await setup()
    const response = await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: [{ kind: 'UNKNOWN', version: '1' }] }, 'idem-agree-0005'),
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
  })
})

describeFirestore('同意の撤回', () => {
  it('撤回すると同意が外れ、以後の提供停止を Outbox へ残す', async () => {
    const { tenantId, app } = await setup()
    await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: [{ kind: CROSS_BORDER.kind, version: CROSS_BORDER.version }] }, 'idem-agree-0006'),
    )

    const revoked = await call(
      app,
      '/consents/revocations',
      jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }, 'idem-revoke-0001'),
    )
    assert.equal(revoked.status, 200)
    const document = revoked.body.data.documents.find((d: { kind: string }) => d.kind === 'CROSS_BORDER_AI')
    assert.equal(document.satisfied, false)
    assert.equal(document.agreedVersion, null)

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'consent.revoked')
      .get()
    assert.equal(outbox.size, 1)
  })

  it('同意していない状態への撤回は失敗させない', async () => {
    const { app } = await setup()
    const response = await call(
      app,
      '/consents/revocations',
      jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }, 'idem-revoke-0002'),
    )
    assert.equal(response.status, 200)
  })

  it('他人の同意記録は書き換えられない', async () => {
    const { tenantId, app } = await setup()
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0007'))

    await seedTenantMember(tenantId, 'user-2')
    const other = buildApp(tenantId, 'user-2')
    const status = await call(other, '/consents')

    // 利用者ごとに別の記録であり、他人の同意は引き継がれない。
    assert.equal(status.body.data.outstanding, true)
    assert.deepEqual(status.body.data.availability.missingRequired.sort(), ['PRIVACY', 'TERMS'])
  })
})

describeFirestore('同意と業務APIの関係', () => {
  it('必須同意が無い間は業務APIを拒否し、理由と復旧手段を返す', async () => {
    const { app } = await setup()
    const response = await call(app, '/cases', jsonRequest('POST', caseBody, 'idem-case-0001'))

    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
    assert.deepEqual(response.body.error.details.missingRequired.sort(), ['PRIVACY', 'TERMS'])
    assert.deepEqual(response.body.error.details.availableOperations, ['getConsents', 'agreeConsents'])
  })

  it('任意の外部AI同意が無くても手動管理は使える', async () => {
    const { app } = await setup()
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0008'))

    const created = await call(app, '/cases', jsonRequest('POST', caseBody, 'idem-case-0002'))
    assert.equal(created.status, 201)
    assert.equal((await call(app, '/cases')).status, 200)
  })

  it('必須同意を撤回すると業務APIが再び閉じる', async () => {
    const { app } = await setup()
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0009'))
    assert.equal((await call(app, '/cases')).status, 200)

    await call(app, '/consents/revocations', jsonRequest('POST', { kind: 'TERMS' }, 'idem-revoke-0003'))
    const after = await call(app, '/cases')

    assert.equal(after.status, 403)
    assert.equal(after.body.error.code, 'CONSENT_REQUIRED')
  })

  it('同意文書が改定されると再同意まで業務APIを閉じる', async () => {
    const { tenantId, userId } = await setup()
    const app = buildApp(tenantId, userId)
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0010'))
    assert.equal((await call(app, '/cases')).status, 200)

    // 同じ利用者、改定後のカタログ。版ずれは未同意として扱う。
    const revised: ConsentCatalog = {
      placeholder: true,
      documents: PLACEHOLDER_CATALOG.documents.map((document) =>
        document.kind === 'TERMS' ? { ...document, version: '0.0.1-draft' } : document,
      ),
    }
    const afterRevision = buildApp(tenantId, userId, { catalog: revised })
    const response = await call(afterRevision, '/cases')

    assert.equal(response.status, 403)
    assert.deepEqual(response.body.error.details.missingRequired, ['TERMS'])
  })
})

describeFirestore('外部AI利用の判定', () => {
  it('外部AI同意があるときだけ許可する', async () => {
    const { app } = await setup()
    await call(app, '/consents', jsonRequest('POST', { agreements: requiredAgreements }, 'idem-agree-0011'))
    let status = await call(app, '/consents')
    assert.equal(status.body.data.availability.externalAi, false)

    await call(
      app,
      '/consents',
      jsonRequest('POST', { agreements: [{ kind: CROSS_BORDER.kind, version: CROSS_BORDER.version }] }, 'idem-agree-0012'),
    )
    status = await call(app, '/consents')
    assert.equal(status.body.data.availability.externalAi, true)
    assert.equal(status.body.data.availability.manualManagement, true)
  })
})

describeFirestore('同意カタログの設定', () => {
  it('本番では未確定の仮文面を使えない', () => {
    assert.throws(
      () => readConsentCatalog({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      /CONSENT_CATALOG_PATH/,
    )
  })

  it('開発では仮文面と分かる形で使える', () => {
    const catalog = readConsentCatalog({} as NodeJS.ProcessEnv)
    assert.equal(catalog.placeholder, true)
    // 提供先や国名を実装側で作らない。
    for (const document of catalog.documents) {
      assert.ok(document.summary.join('').includes('未確定'))
    }
  })
})
