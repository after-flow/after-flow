import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AccessService } from '../../src/application/authorization/case-access.js'
import type { TenantMember } from '../../src/application/authorization/case-access.js'
import type { AuthenticatedUser, VerifiedIdentity } from '../../src/application/ports/identity.js'
import type { CaseMember, CaseRole } from '../../src/domain/authorization/case-role.js'
import { collections } from '../../src/domain/shared/collections.js'
import type { EntityBase } from '../../src/domain/shared/entity.js'
import { AppError } from '../../src/shared/app-error.js'
import {
  describeFirestore,
  newId,
  newTenantId,
  readRepository,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

interface TestCase extends EntityBase {
  deceasedName: string
}

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

async function seedTenantMember(tenantId: string, userId: string, active = true): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<TenantMember>(
      { collection: collections.members, caseId: null, id: userId },
      { id: userId, userId, active },
    )
  })
}

async function seedCase(tenantId: string, caseId: string): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<TestCase>(
      { collection: collections.cases, caseId: null, id: caseId },
      { id: caseId, deceasedName: '架空 太郎' },
    )
  })
}

async function seedCaseMember(
  tenantId: string,
  caseId: string,
  userId: string,
  role: CaseRole,
  options: { active?: boolean; personId?: string | null } = {},
): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<CaseMember>(
      { collection: collections.caseMembers, caseId, id: userId },
      {
        id: userId,
        userId,
        role,
        active: options.active ?? true,
        personId: options.personId ?? null,
      },
    )
  })
}

async function rejection(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (cause) {
    assert.ok(cause instanceof AppError, `AppError ではない: ${String(cause)}`)
    return cause
  }
  throw new Error('エラーが発生しなかった')
}

function service(): AccessService {
  return new AccessService(readRepository())
}

describeFirestore('tenant membership による裏取り', () => {
  it('membership がある tenant では認証済み利用者を返す', async () => {
    const tenantId = newTenantId()
    await seedTenantMember(tenantId, 'user-1')
    const user = await service().resolveUser(identityFor('user-1'), tenantId)
    assert.deepEqual(user, { userId: 'user-1', tenantId })
  })

  it('membership が無い tenant では null を返す（未登録。route 層が NOT_REGISTERED にする）', async () => {
    const tenantA = newTenantId()
    const tenantB = newTenantId()
    await seedTenantMember(tenantA, 'user-1')
    // 別 tenant には membership が無い。
    const user = await service().resolveUser(identityFor('user-1'), tenantB)
    assert.equal(user, null)
  })

  it('停止済みの利用者を拒否する', async () => {
    const tenantId = newTenantId()
    await seedTenantMember(tenantId, 'user-1', false)
    const error = await rejection(() => service().resolveUser(identityFor('user-1'), tenantId))
    assert.equal(error.code, 'FORBIDDEN')
    assert.equal(error.details?.reason, 'MEMBERSHIP_INACTIVE')
  })
})

describeFirestore('Case membership による認可', () => {
  async function setup(role: CaseRole, options: { personId?: string | null } = {}) {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const userId = 'user-1'
    await seedTenantMember(tenantId, userId)
    await seedCase(tenantId, caseId)
    await seedCaseMember(tenantId, caseId, userId, role, options)
    const user: AuthenticatedUser = { userId, tenantId }
    return { tenantId, caseId, user }
  }

  it('VIEWER は閲覧できるが更新はできない', async () => {
    const { caseId, user } = await setup('VIEWER')
    const access = await service().authorizeCase(user, caseId, 'case.read')
    assert.equal(access.role, 'VIEWER')

    const error = await rejection(() => service().authorizeCase(user, caseId, 'case.write'))
    assert.equal(error.code, 'FORBIDDEN')
    assert.equal(error.status, 403)
  })

  it('EDITOR は更新できるが Case の管理操作はできない', async () => {
    const { caseId, user } = await setup('EDITOR')
    await service().authorizeCase(user, caseId, 'case.write')
    const error = await rejection(() => service().authorizeCase(user, caseId, 'case.administer'))
    assert.equal(error.code, 'FORBIDDEN')
  })

  it('OWNER は管理操作まで行える', async () => {
    const { caseId, user } = await setup('OWNER')
    const access = await service().authorizeCase(user, caseId, 'case.administer')
    assert.equal(access.role, 'OWNER')
  })

  it('非メンバーには存在を明かさない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    await seedTenantMember(tenantId, 'user-2')
    await seedCase(tenantId, caseId)

    const error = await rejection(() =>
      service().authorizeCase({ userId: 'user-2', tenantId }, caseId, 'case.read'),
    )
    // FORBIDDEN を返すと、ID の総当たりで他人の Case の実在を確認できてしまう。
    assert.equal(error.code, 'NOT_FOUND')
  })

  it('Case から外れた利用者は取得できない', async () => {
    const { tenantId, caseId, user } = await setup('OWNER')
    await unitOfWork().run(workContext(tenantId), async (tx) => {
      const member = await tx.require<CaseMember>({
        collection: collections.caseMembers,
        caseId,
        id: user.userId,
      })
      tx.update<CaseMember>(
        { collection: collections.caseMembers, caseId, id: user.userId },
        member.version,
        { active: false },
      )
    })

    const error = await rejection(() => service().authorizeCase(user, caseId, 'case.read'))
    assert.equal(error.code, 'NOT_FOUND')
  })

  it('別 tenant の Case へは到達できない', async () => {
    const other = await setup('OWNER')
    const tenantId = newTenantId()
    await seedTenantMember(tenantId, 'user-1')

    const error = await rejection(() =>
      service().authorizeCase({ userId: 'user-1', tenantId }, other.caseId, 'case.read'),
    )
    assert.equal(error.code, 'NOT_FOUND')
  })
})

describeFirestore('本人としての操作', () => {
  it('紐付いた Person の操作だけを本人として許す', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    await seedTenantMember(tenantId, 'user-1')
    await seedCase(tenantId, caseId)
    await seedCaseMember(tenantId, caseId, 'user-1', 'VIEWER', { personId: 'person-self' })

    const access = await service().authorizeCase(
      { userId: 'user-1', tenantId },
      caseId,
      'decision.confirm.self',
    )
    access.assertSelf('person-self')
    assert.throws(() => access.assertSelf('person-other'), (error: unknown) => {
      return error instanceof AppError && error.code === 'FORBIDDEN'
    })
  })

  it('Case の所有者でも他の家族の意思を本人として確定できない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    await seedTenantMember(tenantId, 'owner-1')
    await seedCase(tenantId, caseId)
    // 所有者だが、どの Person とも紐付いていない。
    await seedCaseMember(tenantId, caseId, 'owner-1', 'OWNER', { personId: null })

    const access = await service().authorizeCase(
      { userId: 'owner-1', tenantId },
      caseId,
      'decision.confirm.self',
    )
    assert.throws(() => access.assertSelf('person-spouse'), (error: unknown) => {
      return error instanceof AppError && error.code === 'FORBIDDEN'
    })
  })
})

describeFirestore('認可結果から作る実行文脈', () => {
  it('WorkContext の actor は認証済み利用者になる', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    await seedTenantMember(tenantId, 'user-1')
    await seedCase(tenantId, caseId)
    await seedCaseMember(tenantId, caseId, 'user-1', 'EDITOR')

    const access = await service().authorizeCase({ userId: 'user-1', tenantId }, caseId, 'case.write')
    const context = access.toWorkContext('req-1', { key: 'k-00000001', fingerprint: 'fp' })

    assert.equal(context.tenantId, tenantId)
    assert.deepEqual(context.actor, { type: 'USER', userId: 'user-1', agentRunId: null })
    assert.equal(context.requestId, 'req-1')
  })
})
