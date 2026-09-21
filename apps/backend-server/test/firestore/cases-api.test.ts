import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createMiddleware } from 'hono/factory'
import { createApp } from '../../src/app.js'
import { collections, INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { AppEnv } from '../../src/presentation/http/context.js'
import { createPublicV1Routes } from '../../src/presentation/routes/public/v1/index.js'
import {
  agreeRequiredConsents,
  buildApp,
  call,
  seedTenantMember,
} from './helpers/app.js'
import type { Json } from './helpers/app.js'
import {
  describeFirestore,
  firestore,
  newTenantId,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

/** 必須同意まで済ませた利用者のアプリ。業務 API の前提を揃える。 */
async function appFor(tenantId: string, userId: string) {
  const app = buildApp(tenantId, userId)
  await agreeRequiredConsents(app)
  return app
}

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

async function setup() {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  return { tenantId, userId, app: await appFor(tenantId, userId) }
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
    assert.equal(audits.size, 1)
    assert.equal(audits.docs[0]?.get('type'), 'case.created')

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
