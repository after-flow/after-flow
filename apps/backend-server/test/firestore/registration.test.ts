import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createMiddleware } from 'hono/factory'
import { ContextVersionUnitOfWork } from '../../src/application/case/context-version-unit-of-work.js'
import type { TenantMember } from '../../src/application/authorization/case-access.js'
import { RegistrationService } from '../../src/application/identity/registration-service.js'
import type { VerifiedIdentity } from '../../src/application/ports/identity.js'
import { collections } from '../../src/domain/shared/collections.js'
import { createApp } from '../../src/app.js'
import type { AppEnv } from '../../src/presentation/http/context.js'
import { createMeRoutes } from '../../src/presentation/routes/public/v1/me.js'
import { describeFirestore, firestore, newTenantId, readRepository, unitOfWork, workContext } from './helpers/emulator.js'

function identityFor(userId: string): VerifiedIdentity {
  return {
    subject: userId,
    email: null,
    emailVerified: true,
    authTime: null,
    issuer: 'https://issuer.example.test/',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function service(tenantId: string): RegistrationService {
  return new RegistrationService(tenantId, readRepository(), new ContextVersionUnitOfWork(unitOfWork()))
}

async function seedInactiveMember(tenantId: string, userId: string): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<TenantMember>(
      { collection: collections.members, caseId: null, id: userId },
      { id: userId, userId, active: false },
    )
  })
}

describeFirestore('RegistrationService', () => {
  it('未登録の identity を新規作成する', async () => {
    const tenantId = newTenantId()
    const { view, created } = await service(tenantId).register(identityFor('user-1'), null, null)
    assert.equal(created, true)
    assert.equal(view.registered, true)
    assert.equal(view.active, true)
    assert.equal(view.userId, 'user-1')
    assert.equal(view.tenantId, tenantId)
    assert.ok(view.registeredAt)
  })

  it('登録済みの再実行は新規作成せず、同じ状態を返す（自身が冪等）', async () => {
    const tenantId = newTenantId()
    const s = service(tenantId)
    const first = await s.register(identityFor('user-1'), null, null)
    const second = await s.register(identityFor('user-1'), null, null)
    assert.equal(second.created, false)
    assert.equal(second.view.registeredAt, first.view.registeredAt)
  })

  it('停止済み membership は active:false を返す（403への変換は route 層）', async () => {
    const tenantId = newTenantId()
    await seedInactiveMember(tenantId, 'user-1')
    const { view, created } = await service(tenantId).register(identityFor('user-1'), null, null)
    assert.equal(created, false)
    assert.equal(view.registered, true)
    assert.equal(view.active, false)
  })

  it('get は未登録でも書き込まずに registered:false を返す', async () => {
    const tenantId = newTenantId()
    const view = await service(tenantId).get(identityFor('user-1'))
    assert.equal(view.registered, false)
    assert.equal(view.active, false)
    assert.equal(view.registeredAt, null)
  })

  it('登録は同じ Transaction で member.registered の監査イベントを残す', async () => {
    const tenantId = newTenantId()
    await service(tenantId).register(identityFor('user-1'), 'req-1', null)
    const snapshot = await firestore().collection(`tenants/${tenantId}/auditEvents`).get()
    const events = snapshot.docs.map((doc) => doc.data())
    const registered = events.find((event) => event.type === 'member.registered')
    assert.ok(registered, '監査イベントが残っていない')
    assert.equal(registered?.target?.id, 'user-1')
    assert.equal(registered?.requestId, 'req-1')
  })
})

function buildMeApp(tenantId: string, userId: string | null) {
  const registrationService = service(tenantId)
  const app = createApp({
    routes: createMeRoutes(registrationService),
    // トークン検証と tenant 裏取りは authentication.test.ts / authorization.test.ts で見る。
    // ここでは route の auth:'identity' 判定と Service の統合だけを見る。
    authentication: createMiddleware<AppEnv>(async (c, next) => {
      if (userId) c.set('identity', identityFor(userId))
      await next()
    }),
  })
  return { app, registrationService }
}

async function call(app: ReturnType<typeof createApp>, method: string, headers: Record<string, string> = {}) {
  const response = await app.request('http://localhost/api/v1/me', { method, headers })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

describeFirestore('GET/POST /me', () => {
  it('identity が無ければ 401', async () => {
    const { app } = buildMeApp(newTenantId(), null)
    const { status } = await call(app, 'GET')
    assert.equal(status, 401)
  })

  it('GET /me は未登録でも 200 で registered:false を返す', async () => {
    const { app } = buildMeApp(newTenantId(), 'user-1')
    const { status, body } = await call(app, 'GET')
    assert.equal(status, 200)
    assert.equal(body.data.registered, false)
  })

  it('POST /me は新規登録で 201', async () => {
    const { app } = buildMeApp(newTenantId(), 'user-1')
    const { status, body } = await call(app, 'POST', { 'Idempotency-Key': 'me-key-00000001' })
    assert.equal(status, 201)
    assert.equal(body.data.registered, true)
    assert.equal(body.data.active, true)
  })

  it('POST /me は登録済みなら 200（idempotency key 無しでも自身が冪等）', async () => {
    const { app, registrationService } = buildMeApp(newTenantId(), 'user-1')
    await registrationService.register(identityFor('user-1'), null, null)
    const { status, body } = await call(app, 'POST')
    assert.equal(status, 200)
    assert.equal(body.data.registered, true)
  })

  it('停止済みは POST /me で 403 MEMBERSHIP_INACTIVE', async () => {
    const tenantId = newTenantId()
    await seedInactiveMember(tenantId, 'user-1')
    const { app } = buildMeApp(tenantId, 'user-1')
    const { status, body } = await call(app, 'POST')
    assert.equal(status, 403)
    assert.equal(body.error.details?.reason, 'MEMBERSHIP_INACTIVE')
  })
})
