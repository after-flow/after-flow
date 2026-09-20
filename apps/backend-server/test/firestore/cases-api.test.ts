import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createMiddleware } from 'hono/factory'
import { createApp } from '../../src/app.js'
import { AccessService } from '../../src/application/authorization/case-access.js'
import type { TenantMember } from '../../src/application/authorization/case-access.js'
import { CaseService } from '../../src/application/case/case-service.js'
import { collections, INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { AppEnv } from '../../src/presentation/http/context.js'
import { createPublicV1Routes } from '../../src/presentation/routes/public/v1/index.js'
import {
  describeFirestore,
  firestore,
  newTenantId,
  readRepository,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

function appFor(tenantId: string, userId: string) {
  const access = new AccessService(readRepository())
  const routes = createPublicV1Routes({
    caseService: new CaseService(access, readRepository(), unitOfWork()),
  })
  // トークン検証そのものは authentication.test.ts が実 Adapter で行う。
  // ここでは認可より後ろの経路を見る。
  const stub = createMiddleware<AppEnv>(async (c, next) => {
    c.set('user', { userId, tenantId })
    await next()
  })
  return createApp({ routes, authentication: stub })
}

async function seedTenantMember(tenantId: string, userId: string): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<TenantMember>(
      { collection: collections.members, caseId: null, id: userId },
      { id: userId, userId, active: true },
    )
  })
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

type Json = Record<string, any>

async function call(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Json }> {
  const response = await app.request(`http://localhost/api/v1${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} }
}

function post(body: unknown, idempotencyKey: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  }
}

function patch(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function setup() {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  return { tenantId, userId, app: appFor(tenantId, userId) }
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
    const outsider = appFor(owner.tenantId, 'user-outsider')
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
    const outsider = appFor(owner.tenantId, 'user-outsider')

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

    const viewer = appFor(owner.tenantId, 'user-viewer')
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

    const viewer = appFor(owner.tenantId, 'user-viewer2')
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
