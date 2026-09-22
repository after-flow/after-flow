import assert from 'node:assert/strict'
import { it } from 'node:test'
import { FieldValue } from '@google-cloud/firestore'
import { createMiddleware } from 'hono/factory'
import { createApp } from '../../src/app.js'
import type { Clock } from '../../src/application/ports.js'
import { collections, INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { AppEnv } from '../../src/presentation/http/context.js'
import { createPublicV1Routes } from '../../src/presentation/routes/public/v1/index.js'
import {
  agreeRequiredConsents,
  buildApp,
  call,
  jsonRequest,
  seedHeir,
  seedTenantMember,
} from './helpers/app.js'
import type { Json, TestAppOptions } from './helpers/app.js'
import {
  describeFirestore,
  firestore,
  newTenantId,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

/** 必須同意まで済ませた利用者のアプリ。業務 API の前提を揃える。 */
async function appFor(tenantId: string, userId: string, options: TestAppOptions = {}) {
  const app = buildApp(tenantId, userId, options)
  await agreeRequiredConsents(app)
  return app
}

/** 日付境界のテスト用に固定した「今日」。JST 2026-06-15。 */
const FIXED_NOW = '2026-06-15T03:00:00.000Z'
const TODAY_JST = '2026-06-15'
const fixedClock: Clock = { now: () => FIXED_NOW }

const validBody = {
  deceasedName: '架空 太郎',
  deceasedNameKana: 'カクウ タロウ',
  dateOfDeath: '2026-04-01',
  dateOfBirth: '1950-03-02',
  knownAt: '2026-04-03',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
  municipality: '架空市',
}

function post(body: unknown, idempotencyKey: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  }
}

function patch(body: unknown, key = `patch-${Math.random()}`): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  }
}

async function setup(options: TestAppOptions = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  return { tenantId, userId, app: await appFor(tenantId, userId, options) }
}

describeFirestore('案件の作成', () => {
  it('作成すると版 1 の案件と OWNER の membership が揃う', async () => {
    const { tenantId, userId, app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-create-0001'))

    assert.equal(created.status, 201)
    assert.equal(created.body.data.deceasedName, '架空 太郎')
    assert.equal(created.body.data.status, 'ACTIVE')
    assert.equal(created.body.data.version, 1)
    assert.equal(created.body.data.caseVersion, 1)
    assert.deepEqual(created.body.data.allowedActions, ['UPDATE_BASIC_INFO', 'ADMINISTER'])
    assert.ok(created.body.meta.requestId)

    const caseId = created.body.data.id
    const member = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/caseMembers/${userId}`).get()
    assert.equal(member.get('role'), 'OWNER')
    assert.equal(member.get('active'), true)
    // 人の登録と本人確認は別。作成しただけでは Person と紐付かない。
    assert.equal(member.get('personId'), null)
  })

  it('死亡日と知った日を別の事実として保持する', async () => {
    const { app } = await setup()
    const created = await call(
      app,
      '/cases',
      post({ ...validBody, knownAt: undefined }, 'idem-create-0002'),
    )
    assert.equal(created.status, 201)
    assert.equal(created.body.data.dateOfDeath, '2026-04-01')
    // 不明な起算日を死亡日で黙って補完しない。
    assert.equal(created.body.data.knownAt, null)
  })

  it('作成の事実を監査と Outbox に残す', async () => {
    const { tenantId, app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-create-0003'))
    const caseId = created.body.data.id

    const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
    // 初期手続きの同期生成（task.rule_synced）が同じ Transaction で走る。
    assert.deepEqual(audits.docs.map(d => d.get('type')).sort(), ['case.created', 'task.rule_synced'])

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .get()
    assert.equal(outbox.size, 1)
    assert.equal(outbox.docs[0]?.get('type'), 'case.created')
    assert.equal(outbox.docs[0]?.get('status'), 'PENDING')
  })

  it('同じ要求の再送で案件が重複しない', async () => {
    const { tenantId, app } = await setup()
    const first = await call(app, '/cases', post(validBody, 'idem-create-0004'))
    const second = await call(app, '/cases', post(validBody, 'idem-create-0004'))

    assert.equal(second.status, 201)
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal((await firestore().collection(`tenants/${tenantId}/cases`).get()).size, 1)
  })

  it('同じキーで内容が異なる要求を拒否する', async () => {
    const { app } = await setup()
    await call(app, '/cases', post(validBody, 'idem-create-0005'))
    const conflicting = await call(
      app,
      '/cases',
      post({ ...validBody, deceasedName: '別 人物' }, 'idem-create-0005'),
    )
    assert.equal(conflicting.status, 409)
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('Idempotency-Key が無い作成要求を 428 で拒否する', async () => {
    const { app } = await setup()
    const response = await call(app, '/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    assert.equal(response.status, 428)
    assert.equal(response.body.error.code, 'PRECONDITION_REQUIRED')
  })

  it('契約にない項目を拒否する', async () => {
    const { app } = await setup()
    const response = await call(
      app,
      '/cases',
      post({ ...validBody, status: 'CLOSED' }, 'idem-create-0006'),
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
  })
})

describeFirestore('案件の取得と一覧', () => {
  it('作成直後に詳細を取得できる', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-get-0001'))
    const fetched = await call(app, `/cases/${created.body.data.id}`)

    assert.equal(fetched.status, 200)
    assert.deepEqual(fetched.body.data, created.body.data)
  })

  it('参加していない案件は見つからない', async () => {
    const owner = await setup()
    const created = await call(owner.app, '/cases', post(validBody, 'idem-get-0002'))

    await seedTenantMember(owner.tenantId, 'user-outsider')
    const outsider = await appFor(owner.tenantId, 'user-outsider')
    const fetched = await call(outsider, `/cases/${created.body.data.id}`)

    // FORBIDDEN だと ID の総当たりで実在を確認できる。
    assert.equal(fetched.status, 404)
    assert.equal(fetched.body.error.code, 'NOT_FOUND')
  })

  it('一覧は自分が参加している案件だけを返す', async () => {
    const owner = await setup()
    await call(owner.app, '/cases', post(validBody, 'idem-list-0001'))
    await call(owner.app, '/cases', post(validBody, 'idem-list-0002'))

    await seedTenantMember(owner.tenantId, 'user-outsider')
    const outsider = await appFor(owner.tenantId, 'user-outsider')

    const mine = await call(owner.app, '/cases')
    assert.equal(mine.status, 200)
    assert.equal(mine.body.data.length, 2)

    const theirs = await call(outsider, '/cases')
    assert.equal(theirs.body.data.length, 0)
  })

  it('一覧の続きをカーソルで取得でき、重複も欠落も起きない', async () => {
    const { app } = await setup()
    for (let index = 0; index < 5; index += 1) {
      await call(app, '/cases', post(validBody, `idem-page-000${index}`))
    }

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
      const page = await call(app, `/cases${query}`)
      assert.equal(page.status, 200)
      collected.push(...page.body.data.map((item: Json) => item.id))
      cursor = page.body.meta.nextCursor
      pages += 1
      assert.ok(pages <= 4, 'ページングが終わらない')
    } while (cursor)

    assert.equal(collected.length, 5)
    assert.equal(new Set(collected).size, 5)
  })
})

describeFirestore('案件の訂正', () => {
  it('自治体を訂正すると版と Case 版が進む', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0001'))
    const caseId = created.body.data.id

    const updated = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: 1, municipality: '別の架空市' }),
    )
    assert.equal(updated.status, 200)
    assert.equal(updated.body.data.municipality, '別の架空市')
    assert.equal(updated.body.data.version, 2)
    assert.equal(updated.body.data.caseVersion, 2)
  })

  it('Task 作成などの Context 書き込みで version が進んでも、basicInfoVersion は変わらず訂正できる', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-basicinfo-0001'))
    const caseId = created.body.data.id
    assert.equal(created.body.data.version, 1)
    assert.equal(created.body.data.basicInfoVersion, 1)

    // Task 作成は ContextVersionUnitOfWork の自動 bump パスで version/caseVersion だけ進める。
    await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))

    const afterTask = await call(app, `/cases/${caseId}`)
    assert.equal(afterTask.body.data.version, 2, 'Task 作成で version は進む')
    assert.equal(afterTask.body.data.basicInfoVersion, 1, 'basicInfoVersion は Task 作成では進まない')

    // version（古い実装が使っていた値）を送ると、実際には競合していないのに 409 になる。
    const usingStorageVersion = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: afterTask.body.data.version, municipality: '別の架空市' }),
    )
    assert.equal(usingStorageVersion.status, 409, 'version は basicInfoVersion の代わりに使えない(空振り検知)')

    // basicInfoVersion を送れば、version が進んでいても訂正できる。
    const usingBasicInfoVersion = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: afterTask.body.data.basicInfoVersion, municipality: '別の架空市' }),
    )
    assert.equal(usingBasicInfoVersion.status, 200, JSON.stringify(usingBasicInfoVersion.body))
    assert.equal(usingBasicInfoVersion.body.data.municipality, '別の架空市')
    assert.equal(usingBasicInfoVersion.body.data.basicInfoVersion, 2)
  })

  it('basicInfoVersion が欠落した legacy record は version に正規化して訂正できる', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-basicinfo-0002'))
    const caseId = created.body.data.id

    // Task 作成で version だけ 2 に進める（basicInfoVersion 導入前の状態を模す）。
    await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    // basicInfoVersion 導入前に作られた record を模して、フィールドごと消す。
    await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).update({ basicInfoVersion: FieldValue.delete() })

    const legacy = await call(app, `/cases/${caseId}`)
    assert.equal(legacy.body.data.version, 2)
    assert.equal(legacy.body.data.basicInfoVersion, 2, 'legacy record は読み出し時に version へ正規化される')

    const updated = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: legacy.body.data.basicInfoVersion, municipality: '別の架空市' }),
    )
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.data.basicInfoVersion, 3)
  })

  it('古い版での訂正は 409 になり、先行更新を上書きしない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0002'))
    const caseId = created.body.data.id

    await call(app, `/cases/${caseId}`, patch({ expectedVersion: 1, ownerName: '先行 更新' }))
    const stale = await call(app, `/cases/${caseId}`, patch({ expectedVersion: 1, ownerName: '後追い 更新' }))

    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'CONFLICT')

    const current = await call(app, `/cases/${caseId}`)
    assert.equal(current.body.data.ownerName, '先行 更新')
  })

  it('expectedVersion の欠落を 428 で返す', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0003'))
    const response = await call(app, `/cases/${created.body.data.id}`, patch({ ownerName: '版なし' }))

    assert.equal(response.status, 428)
    assert.equal(response.body.error.code, 'PRECONDITION_REQUIRED')
    assert.equal(response.body.error.details.field, 'expectedVersion')
  })

  it('status を PATCH で変更できない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0004'))
    const response = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, status: 'CLOSED' }),
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
  })

  it('起算日の変更は再評価の要求を Outbox に残す', async () => {
    const { tenantId, app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0005'))
    await call(app, `/cases/${created.body.data.id}`, patch({ expectedVersion: 1, knownAt: '2026-04-10' }))

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'case.reference_dates_changed')
      .get()
    assert.equal(outbox.size, 1)
    assert.equal(outbox.docs[0]?.get('payload').knownAt, '2026-04-10')
  })

  it('内容が変わらない訂正では版を進めない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-patch-0006'))
    const unchanged = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, municipality: validBody.municipality }),
    )
    assert.equal(unchanged.status, 200)
    // 無意味に版を進めると、AI の提案が理由なく stale になる。
    assert.equal(unchanged.body.data.version, 1)
    assert.equal(unchanged.body.data.caseVersion, 1)
  })

  it('閲覧のみの利用者は訂正できない', async () => {
    const owner = await setup()
    const created = await call(owner.app, '/cases', post(validBody, 'idem-patch-0007'))
    const caseId = created.body.data.id

    await seedTenantMember(owner.tenantId, 'user-viewer')
    await unitOfWork().run(workContext(owner.tenantId), async (tx) => {
      tx.create({
        collection: collections.caseMembers,
        caseId,
        id: 'user-viewer',
      }, { id: 'user-viewer', userId: 'user-viewer', role: 'VIEWER', active: true, personId: null } as never)
    })

    const viewer = await appFor(owner.tenantId, 'user-viewer')
    assert.equal((await call(viewer, `/cases/${caseId}`)).status, 200)

    const rejected = await call(viewer, `/cases/${caseId}`, patch({ expectedVersion: 1, ownerName: 'x' }))
    assert.equal(rejected.status, 403)
    assert.equal(rejected.body.error.code, 'FORBIDDEN')
  })

  it('閲覧のみの利用者には訂正の導線を返さない', async () => {
    const owner = await setup()
    const created = await call(owner.app, '/cases', post(validBody, 'idem-patch-0008'))
    const caseId = created.body.data.id

    await seedTenantMember(owner.tenantId, 'user-viewer2')
    await unitOfWork().run(workContext(owner.tenantId), async (tx) => {
      tx.create({
        collection: collections.caseMembers,
        caseId,
        id: 'user-viewer2',
      }, { id: 'user-viewer2', userId: 'user-viewer2', role: 'VIEWER', active: true, personId: null } as never)
    })

    const viewer = await appFor(owner.tenantId, 'user-viewer2')
    const fetched = await call(viewer, `/cases/${caseId}`)
    assert.deepEqual(fetched.body.data.allowedActions, [])
  })
})

describeFirestore('業務機能が未接続の場合', () => {
  it('理由付きで拒否し、空配列で成功に見せない', async () => {
    const app = createApp({
      routes: createPublicV1Routes(null),
      authentication: createMiddleware<AppEnv>(async (c, next) => {
        c.set('user', { userId: 'user-1', tenantId: 'tenant-1' })
        await next()
      }),
    })
    const response = await call(app, '/cases')
    assert.equal(response.status, 501)
    assert.equal(response.body.error.code, 'FEATURE_NOT_CONNECTED')
  })
})


describeFirestore('AI planning restriction', () => {
  it('owner can pause and clear planning with versions, idempotency and a reason-free audit', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'planning-create'))
    const id = created.body.data.id, url = `/cases/${id}/ai-planning-restriction`
    assert.equal(created.body.data.aiPlanningRestriction, null)
    const request = patch({ expectedVersion: 1, restriction: { reason: '  private pause reason  ' } }, 'planning-pause')
    const paused = await call(app, url, request)
    assert.equal(paused.status, 200, JSON.stringify(paused.body))
    assert.deepEqual(paused.body.data.aiPlanningRestriction, { reason: 'private pause reason' })
    assert.equal(paused.body.data.caseVersion, 2)
    assert.equal((await call(app, url, request)).body.data.version, 2)
    assert.equal((await call(app, url, patch({ expectedVersion: 1, restriction: null }))).status, 409)
    const noop = await call(app, url, patch({ expectedVersion: 2, restriction: { reason: 'private pause reason' } }))
    assert.equal(noop.body.data.caseVersion, 2)
    const cleared = await call(app, url, patch({ expectedVersion: 2, restriction: null }))
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.data.aiPlanningRestriction, null)
    assert.equal(cleared.body.data.caseVersion, 3)
    const audits = await firestore().collection(`tenants/${tenantId}/cases/${id}/auditEvents`).get()
    const restrictions = audits.docs.filter(d => d.get('type') === 'case.ai_planning_restriction_changed')
    assert.equal(restrictions.length, 2)
    assert.equal(JSON.stringify(restrictions.map(d => d.data())).includes('private pause reason'), false)
  })

  it('editors, viewers and outsiders cannot remove an owner restriction; malformed input is rejected', async () => {
    const { app, tenantId, userId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'planning-authorization'))
    const id = created.body.data.id, url = `/cases/${id}/ai-planning-restriction`
    for (const restriction of [{ reason: '' }, { reason: 'x'.repeat(1001) }, { reason: 'valid', ignore: true }]) {
      assert.equal((await call(app, url, patch({ expectedVersion: 1, restriction }))).status, 400)
    }
    assert.equal((await call(app, url, patch({ expectedVersion: 1, restriction: { reason: 'pause' } }))).status, 200)
    assert.equal((await call(app, `/cases/${id}`, patch({ expectedVersion: 2, aiPlanningRestriction: null }))).status, 400)
    for (const role of ['EDITOR', 'VIEWER'] as const) {
      await unitOfWork().run(workContext(tenantId), async tx => {
        const location = { collection: collections.caseMembers, caseId: id, id: userId }
        const current = await tx.require(location)
        tx.update(location, current.version, { role })
      })
      assert.equal((await call(app, url, patch({ expectedVersion: 2, restriction: null }))).status, 403)
    }
    await seedTenantMember(tenantId, 'outsider')
    const outsider = await appFor(tenantId, 'outsider')
    assert.equal((await call(outsider, url, patch({ expectedVersion: 2, restriction: null }))).status, 404)
    assert.deepEqual((await call(app, `/cases/${id}`)).body.data.aiPlanningRestriction, { reason: 'pause' })
  })
})

describeFirestore('本人を同時登録して案件を作成する', () => {
  const ownerPersonBody = { ...validBody, ownerPerson: { isHeir: true } }

  it('ownerPersonId と selfPersonId が同じ Person を指し、caseVersion は 1 のまま', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0001'))

    assert.equal(created.status, 201, JSON.stringify(created.body))
    const { id: caseId, ownerPersonId, selfPersonId } = created.body.data
    assert.ok(ownerPersonId)
    assert.equal(selfPersonId, ownerPersonId)
    assert.equal(created.body.data.caseVersion, 1)

    const caseDoc = await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).get()
    assert.equal(caseDoc.get('ownerPersonId'), ownerPersonId)

    const personDoc = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/persons/${ownerPersonId}`).get()
    assert.ok(personDoc.exists)
    assert.equal(personDoc.get('name'), validBody.ownerName)
    assert.equal(personDoc.get('relationshipLabel'), validBody.relationshipToDeceased)
    assert.equal(personDoc.get('role'), 'HEIR_CANDIDATE')
    assert.equal(personDoc.get('isHeir'), true)
    assert.equal(personDoc.get('excludedAt'), null)
    assert.equal(personDoc.get('caseId'), caseId)
    assert.equal(personDoc.get('createdBy').id, 'user-owner')

    const memberDoc = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/caseMembers/user-owner`).get()
    assert.equal(memberDoc.get('personId'), ownerPersonId)

    const personsList = await call(app, `/cases/${caseId}/persons`)
    assert.equal(personsList.status, 200)
    assert.deepEqual(personsList.body.data.map((p: Json) => p.id), [ownerPersonId])

    const fetched = await call(app, `/cases/${caseId}`)
    assert.equal(fetched.body.data.ownerPersonId, ownerPersonId)
    assert.equal(fetched.body.data.selfPersonId, ownerPersonId)
  })

  it('監査は case.created・person.created・task.rule_synced の3件、case.context_changed は無い。Outbox は case.created 1件', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0002'))
    const caseId = created.body.data.id

    const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
    const types = audits.docs.map(d => d.get('type')).sort()
    assert.deepEqual(types, ['case.created', 'person.created', 'task.rule_synced'])

    const outbox = await firestore().collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`).get()
    assert.equal(outbox.size, 1)
    assert.equal(outbox.docs[0]?.get('type'), 'case.created')
  })

  it('isHeir:false でも ownerPersonId は設定され、role は RELATED。相続方法は確定できない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post({ ...validBody, ownerPerson: { isHeir: false } }, 'idem-owner-0003'))
    const { id: caseId, ownerPersonId } = created.body.data
    assert.ok(ownerPersonId)

    const fetched = await call(app, `/cases/${caseId}/persons`)
    assert.equal(fetched.body.data[0].role, 'RELATED')
    assert.equal(fetched.body.data[0].isHeir, false)

    const decision = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/${ownerPersonId}`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }),
    )
    // 有効な相続人候補ではないため確定できない。
    assert.equal(decision.status, 409)
    assert.equal(decision.body.error.code, 'PRECONDITION_FAILED')
  })

  it('冪等再送は同じ Person を再利用し、ownerPerson を変えた再送は409', async () => {
    const { app, tenantId } = await setup()
    const first = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0004'))
    const second = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0004'))

    assert.equal(second.status, 201)
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal(second.body.data.ownerPersonId, first.body.data.ownerPersonId)
    assert.equal((await firestore().collection(`tenants/${tenantId}/cases`).get()).size, 1)
    const persons = await firestore()
      .collection(`tenants/${tenantId}/cases/${first.body.data.id}/persons`)
      .get()
    assert.equal(persons.size, 1)

    const conflicting = await call(
      app,
      '/cases',
      post({ ...ownerPersonBody, ownerPerson: { isHeir: false } }, 'idem-owner-0004'),
    )
    assert.equal(conflicting.status, 409)
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('不正な ownerPerson は400', async () => {
    const { app } = await setup()
    for (const ownerPerson of [{}, { isHeir: true, extra: 1 }, { isHeir: 'yes' }]) {
      const response = await call(app, '/cases', post({ ...validBody, ownerPerson }, `idem-owner-bad-${Math.random()}`))
      assert.equal(response.status, 400, JSON.stringify(response.body))
      assert.equal(response.body.error.code, 'VALIDATION_FAILED')
    }
  })

  it('本人は自分の相続方法を確定できる。別 Person では403', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0005'))
    const caseId = created.body.data.id as string
    const ownerPersonId = created.body.data.ownerPersonId as string

    const recorded = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/${ownerPersonId}`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }),
    )
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body))

    const confirmed = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/${ownerPersonId}/confirm`,
      jsonRequest('POST', { expectedVersion: recorded.body.data.version, method: 'SIMPLE_ACCEPTANCE' }),
    )
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.data.confirmed, true)

    // 案件の所有者でも、紐付いていない別の Person の意思を本人として確定できない。
    await seedHeir(tenantId, caseId, 'person-other')
    const other = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-other`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }),
    )
    assert.equal(other.status, 200, JSON.stringify(other.body))
    const forbidden = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-other/confirm`,
      jsonRequest('POST', { expectedVersion: other.body.data.version, method: 'SIMPLE_ACCEPTANCE' }),
    )
    assert.equal(forbidden.status, 403)
  })

  it('OWNER が作成した Case を EDITOR が読むと ownerPersonId は非null・selfPersonId は null', async () => {
    const owner = await setup()
    const created = await call(owner.app, '/cases', post(ownerPersonBody, 'idem-owner-0006'))
    const caseId = created.body.data.id

    await seedTenantMember(owner.tenantId, 'user-editor')
    await unitOfWork().run(workContext(owner.tenantId), async tx => {
      tx.create(
        { collection: collections.caseMembers, caseId, id: 'user-editor' },
        { id: 'user-editor', userId: 'user-editor', role: 'EDITOR', active: true, personId: null } as never,
      )
    })
    const editor = await appFor(owner.tenantId, 'user-editor')
    const fetched = await call(editor, `/cases/${caseId}`)
    assert.equal(fetched.body.data.ownerPersonId, created.body.data.ownerPersonId)
    assert.equal(fetched.body.data.selfPersonId, null)

    const list = await call(editor, '/cases')
    assert.equal(list.body.data[0].selfPersonId, null)
  })

  it('PATCH /cases/:caseId に ownerPersonId を送ると400', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(ownerPersonBody, 'idem-owner-0007'))
    const response = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, ownerPersonId: 'person_forged' }),
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
  })
})

describeFirestore('本人フラグ無しでの作成（後方互換）', () => {
  it('ownerPersonId/selfPersonId は null、persons は0件、監査は case.created と task.rule_synced の2件', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-compat-0001'))
    assert.equal(created.status, 201)
    assert.equal(created.body.data.ownerPersonId, null)
    assert.equal(created.body.data.selfPersonId, null)

    const caseId = created.body.data.id
    const member = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/caseMembers/user-owner`).get()
    assert.equal(member.get('personId'), null)

    const persons = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/persons`).get()
    assert.equal(persons.size, 0)

    const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
    assert.deepEqual(audits.docs.map(d => d.get('type')).sort(), ['case.created', 'task.rule_synced'])
  })

  it('ownerPerson: null は省略と同じ挙動', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post({ ...validBody, ownerPerson: null }, 'idem-compat-0002'))
    assert.equal(created.status, 201)
    assert.equal(created.body.data.ownerPersonId, null)
  })

  it('後から POST /cases/:caseId/persons で本人を登録できる', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-compat-0003'))
    const caseId = created.body.data.id
    const person = await call(
      app,
      `/cases/${caseId}/persons`,
      jsonRequest('POST', { name: validBody.ownerName, relationship: validBody.relationshipToDeceased, isHeir: true }),
    )
    assert.equal(person.status, 201, JSON.stringify(person.body))
  })
})

describeFirestore('案件作成の日付検証', () => {
  const future = '2026-06-17' // TODAY_JST + 2日
  const past = '2026-04-01'

  it('未来の死亡日を拒否し、何も残さない', async () => {
    const { app, tenantId } = await setup({ clock: fixedClock })
    const key = 'idem-date-0001'
    const response = await call(app, '/cases', post({ ...validBody, dateOfDeath: future, knownAt: null }, key))
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
    assert.equal(response.body.error.details.source, 'body')
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['dateOfDeath', 'DATE_OF_DEATH_IN_FUTURE']],
    )

    assert.equal((await firestore().collection(`tenants/${tenantId}/cases`).get()).size, 0)
    assert.equal((await firestore().collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`).get()).size, 0)

    // 同じキーで正しい内容を送れば作成できる（冪等文書が残っていない証拠）。
    const retry = await call(app, '/cases', post({ ...validBody, dateOfDeath: past, knownAt: null }, key))
    assert.equal(retry.status, 201, JSON.stringify(retry.body))
  })

  it('知った日が死亡日より前は拒否する', async () => {
    const { app } = await setup({ clock: fixedClock })
    const response = await call(app, '/cases', post({ ...validBody, dateOfDeath: '2026-04-10', knownAt: '2026-04-01' }, 'idem-date-0002'))
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['knownAt', 'KNOWN_AT_BEFORE_DATE_OF_DEATH']],
    )
  })

  it('未来の知った日を拒否する（死亡日は過去）', async () => {
    const { app } = await setup({ clock: fixedClock })
    const response = await call(app, '/cases', post({ ...validBody, dateOfDeath: past, knownAt: future }, 'idem-date-0003'))
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['knownAt', 'KNOWN_AT_IN_FUTURE']],
    )
  })

  it('未来の死亡日かつ知った日が死亡日より前は、両方の path を返す', async () => {
    const { app } = await setup({ clock: fixedClock })
    const response = await call(app, '/cases', post({ ...validBody, dateOfDeath: future, knownAt: past }, 'idem-date-0004'))
    assert.equal(response.status, 400)
    const paths = response.body.error.details.issues.map((i: Json) => i.path).sort()
    assert.deepEqual(paths, ['dateOfDeath', 'knownAt'])
  })

  it('境界（今日と同日）はすべて有効', async () => {
    const { app } = await setup({ clock: fixedClock })
    const okDeath = await call(app, '/cases', post({ ...validBody, dateOfDeath: TODAY_JST, knownAt: null }, 'idem-date-0005'))
    assert.equal(okDeath.status, 201, JSON.stringify(okDeath.body))

    const okKnownEqualsDeath = await call(
      app, '/cases', post({ ...validBody, dateOfDeath: past, knownAt: past }, 'idem-date-0006'),
    )
    assert.equal(okKnownEqualsDeath.status, 201)

    const okKnownEqualsToday = await call(
      app, '/cases', post({ ...validBody, dateOfDeath: past, knownAt: TODAY_JST }, 'idem-date-0007'),
    )
    assert.equal(okKnownEqualsToday.status, 201, JSON.stringify(okKnownEqualsToday.body))
  })
})

describeFirestore('案件訂正の日付検証', () => {
  it('知った日を死亡日より前に訂正すると400', async () => {
    const { app } = await setup({ clock: fixedClock })
    const created = await call(app, '/cases', post(validBody, 'idem-patch-date-0001'))
    const response = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, knownAt: '2026-03-01' }),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['knownAt', 'KNOWN_AT_BEFORE_DATE_OF_DEATH']],
    )
  })

  it('死亡日を既存の知った日より後に訂正すると400', async () => {
    const { app } = await setup({ clock: fixedClock })
    const created = await call(app, '/cases', post(validBody, 'idem-patch-date-0002'))
    const response = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, dateOfDeath: '2026-04-05' }),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['knownAt', 'KNOWN_AT_BEFORE_DATE_OF_DEATH']],
    )
  })

  it('日付に触れない PATCH は、既存の日付不整合を巻き込まない', async () => {
    const { app, tenantId } = await setup({ clock: fixedClock })
    const created = await call(app, '/cases', post(validBody, 'idem-patch-date-0003'))
    const caseId = created.body.data.id

    // legacy な不整合を直接 Firestore に作る（knownAt が dateOfDeath より前）。
    // この直接書き込みは version（保存層のロック）だけを進め、基本情報 PATCH が
    // 見る basicInfoVersion には影響しない。
    await unitOfWork().run(workContext(tenantId), async tx => {
      const location = { collection: collections.cases, caseId: null, id: caseId }
      const current = await tx.require(location)
      tx.update(location, current.version, { dateOfDeath: '2026-05-01', knownAt: '2026-04-01' })
    })

    const municipalityOnly = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: 1, municipality: '別の架空市' }),
    )
    assert.equal(municipalityOnly.status, 200, JSON.stringify(municipalityOnly.body))

    const fixDates = await call(
      app,
      `/cases/${caseId}`,
      patch({ expectedVersion: 2, dateOfDeath: '2026-04-01', knownAt: '2026-04-01' }),
    )
    assert.equal(fixDates.status, 200, JSON.stringify(fixDates.body))
  })

  it('既存の knownAt PATCH（過去日）は引き続き200', async () => {
    const { app } = await setup({ clock: fixedClock })
    const created = await call(app, '/cases', post(validBody, 'idem-patch-date-0004'))
    const response = await call(
      app,
      `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, knownAt: '2026-04-10' }),
    )
    assert.equal(response.status, 200)
  })
})

async function tasksOf(app: ReturnType<typeof buildApp>, caseId: string): Promise<Json[]> {
  const list = await call(app, `/cases/${caseId}/tasks?limit=50`)
  return list.body.data
}

function findByTitle(tasks: Json[], title: string): Json | undefined {
  return tasks.find((task) => task.title === title)
}

describeFirestore('profile / dateOfBirth の PATCH による洗い出し', () => {
  it('profile を答えると default no の手続きが追加され、case.profile_changed を Outbox に残す', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0001'))
    const caseId = created.body.data.id
    assert.equal(findByTitle(await tasksOf(app, caseId), '固定資産税の相続人代表者を届け出る'), undefined)

    const patched = await call(app, `/cases/${caseId}`, patch({
      expectedVersion: 1,
      profile: { realEstate: 'YES', car: 'YES', answeredAt: '2026-09-20T00:00:00+09:00' },
    }))
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    const tasks = await tasksOf(app, caseId)
    assert.ok(findByTitle(tasks, '固定資産税の相続人代表者を届け出る'))
    assert.ok(findByTitle(tasks, '自動車の名義を変える'))
    const registration = findByTitle(tasks, '不動産の相続登記をする')
    assert.equal(registration?.conditional, false)

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'case.profile_changed')
      .get()
    assert.equal(outbox.size, 1)

    // PATCH で Task/Deadline を書き換えると ContextVersionUnitOfWork が case.context_changed
    // 監査を必ず追加する（作成時は抑止されるが、PATCH 経路では抑止されない）。
    const contextChanged = await firestore()
      .collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`)
      .where('type', '==', 'case.context_changed')
      .get()
    assert.equal(contextChanged.size, 1)
  })

  it('未着手・無記録の手続きは profile の変更で消え、監査 task.removed_by_rule が残る', async () => {
    const { app, tenantId } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0002'))
    const caseId = created.body.data.id
    assert.ok(findByTitle(await tasksOf(app, caseId), '年金の受給停止の手続きをする'))

    const patched = await call(app, `/cases/${caseId}`, patch({
      expectedVersion: 1,
      profile: { pension: 'NONE', answeredAt: '2026-09-20T00:00:00+09:00' },
    }))
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    const tasks = await tasksOf(app, caseId)
    assert.equal(findByTitle(tasks, '年金の受給停止の手続きをする'), undefined)
    assert.equal(findByTitle(tasks, '未支給年金を請求する'), undefined)

    const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
    const removed = audits.docs.filter((d) => d.get('type') === 'task.removed_by_rule')
    assert.equal(removed.length, 2)
    // PATCH 経路では ContextVersionUnitOfWork が case.context_changed 監査を必ず追加する。
    const contextChanged = audits.docs.filter((d) => d.get('type') === 'case.context_changed')
    assert.equal(contextChanged.length, 1)
  })

  it('着手済み・記録ありの手続きは profile が変わっても残る', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0003'))
    const caseId = created.body.data.id
    const pensionTask = findByTitle(await tasksOf(app, caseId), '年金の受給停止の手続きをする')
    assert.ok(pensionTask)

    await call(app, `/cases/${caseId}/tasks/${pensionTask!.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: pensionTask!.version }))

    await call(app, `/cases/${caseId}`, patch({
      expectedVersion: 1,
      profile: { pension: 'NONE', answeredAt: '2026-09-20T00:00:00+09:00' },
    }))

    const stillThere = findByTitle(await tasksOf(app, caseId), '年金の受給停止の手続きをする')
    assert.ok(stillThere, '着手済みの Task は削除されない')
  })

  it('submitTo を手動で具体化すると、以後の profile 変更で規則の窓口に戻らない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0004'))
    const caseId = created.body.data.id
    const householdTask = findByTitle(await tasksOf(app, caseId), '世帯主変更届を出す')
    assert.ok(householdTask)

    const updated = await call(app, `/cases/${caseId}/tasks/${householdTask!.id}`, jsonRequest('PATCH', {
      expectedVersion: householdTask!.version, submitTo: '架空市役所 市民課',
    }))
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.data.submitToSource, 'MANUAL')

    await call(app, `/cases/${caseId}`, patch({
      expectedVersion: 1,
      profile: { realEstate: 'YES', answeredAt: '2026-09-20T00:00:00+09:00' },
    }))

    const afterSync = findByTitle(await tasksOf(app, caseId), '世帯主変更届を出す')
    assert.equal(afterSync?.submitTo, '架空市役所 市民課')
    assert.equal(afterSync?.submitToSource, 'MANUAL')
  })

  it('dateOfBirth の訂正で介護保険の手続きが conditional:false になり、null に戻すと元に戻る', async () => {
    const { app } = await setup()
    // validBody は dateOfBirth 付き（死亡時76歳）なので、生年月日不明から始める。
    const created = await call(app, '/cases', post({ ...validBody, dateOfBirth: null }, 'idem-profile-0005'))
    const caseId = created.body.data.id
    const before = findByTitle(await tasksOf(app, caseId), '介護保険の資格喪失届を出す')
    assert.equal(before?.conditional, true)

    const patched = await call(app, `/cases/${caseId}`, patch({ expectedVersion: 1, dateOfBirth: '1950-01-01' }))
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const after = findByTitle(await tasksOf(app, caseId), '介護保険の資格喪失届を出す')
    assert.equal(after?.conditional, false)

    const reverted = await call(app, `/cases/${caseId}`, patch({ expectedVersion: 2, dateOfBirth: null }))
    assert.equal(reverted.status, 200, JSON.stringify(reverted.body))
    const afterRevert = findByTitle(await tasksOf(app, caseId), '介護保険の資格喪失届を出す')
    assert.equal(afterRevert?.conditional, true)
  })

  it('dateOfBirth が dateOfDeath より後なら400', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0006'))
    const response = await call(app, `/cases/${created.body.data.id}`,
      patch({ expectedVersion: 1, dateOfBirth: '2026-04-02' }))
    assert.equal(response.status, 400)
    assert.deepEqual(
      response.body.error.details.issues.map((i: Json) => [i.path, i.code]),
      [['dateOfBirth', 'DATE_OF_BIRTH_AFTER_DATE_OF_DEATH']],
    )
  })

  it('profile:null で未回答に戻すと CaseResource.profile キーが無くなる', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0007'))
    const caseId = created.body.data.id

    const answered = await call(app, `/cases/${caseId}`, patch({
      expectedVersion: 1,
      profile: { realEstate: 'YES', answeredAt: '2026-09-20T00:00:00+09:00' },
    }))
    assert.ok('profile' in answered.body.data)

    const reset = await call(app, `/cases/${caseId}`, patch({ expectedVersion: 2, profile: null }))
    assert.equal(reset.status, 200, JSON.stringify(reset.body))
    assert.ok(!('profile' in reset.body.data))
  })

  it('同じ Idempotency-Key の再送で Task が増えない', async () => {
    const { app } = await setup()
    const created = await call(app, '/cases', post(validBody, 'idem-profile-0008'))
    const caseId = created.body.data.id
    const before = (await tasksOf(app, caseId)).length

    const key = 'idem-profile-patch-0008'
    const body = { expectedVersion: 1, profile: { realEstate: 'YES', answeredAt: '2026-09-20T00:00:00+09:00' } }
    const first = await call(app, `/cases/${caseId}`, patch(body, key))
    assert.equal(first.status, 200)
    const second = await call(app, `/cases/${caseId}`, patch(body, key))
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.data, first.body.data)

    const after = (await tasksOf(app, caseId)).length
    // realEstate:YES で property-tax-representative / car-transfer は増えないが
    // real-estate-registration が maybe→yes になる分は既存 Task の conditional 更新であり、件数は 1 件だけ増える。
    assert.equal(after, before + 1)
  })
})
