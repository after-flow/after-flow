import type { CaseMember, CaseOperation, CaseRole } from '../../domain/authorization/case-role.js'
import { roleAllows } from '../../domain/authorization/case-role.js'
import { collections } from '../../domain/shared/collections.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { errors } from '../../shared/app-error.js'
import type { AuthenticatedUser, VerifiedIdentity } from '../ports/identity.js'
import type {
  ActorRef,
  IdempotencyRequest,
  ReadRepository,
  WorkContext,
} from '../ports/persistence.js'

/** tenant のメンバー。Case membership とは別の層。 */
export interface TenantMember extends EntityBase {
  userId: string
  active: boolean
}

/**
 * 認可を通った結果。
 *
 * WorkContext をここからしか作れないようにしてある。
 * 認証 middleware を通っただけでは Entity を書き換えられず、
 * Application の認可を飛ばした実装を書きにくくするため。
 */
export class CaseAccess {
  constructor(
    readonly tenantId: string,
    readonly caseId: string,
    readonly role: CaseRole,
    readonly member: CaseMember,
    private readonly userId: string,
  ) {}

  get actor(): ActorRef {
    return { type: 'USER', userId: this.userId, agentRunId: null }
  }

  can(operation: CaseOperation): boolean {
    return roleAllows(this.role, operation)
  }

  assertCan(operation: CaseOperation): void {
    if (!this.can(operation)) {
      throw errors.forbidden({ details: { operation, role: this.role } })
    }
  }

  /**
   * 本人としての操作を許すかどうか。
   *
   * 役割では代替できない。Case の所有者であっても、他の家族の意思を
   * 本人として確定することはできない。
   */
  assertSelf(personId: string): void {
    if (this.member.personId === null || this.member.personId !== personId) {
      throw errors.forbidden({
        message: 'この操作は本人だけが行えます。',
        details: { reason: 'not the linked person' },
      })
    }
  }

  toWorkContext(requestId: string | null, idempotency?: IdempotencyRequest | null): WorkContext {
    return {
      tenantId: this.tenantId,
      actor: this.actor,
      requestId,
      idempotency: idempotency ?? null,
    }
  }
}

/**
 * Case をまだ特定していない操作の実行文脈。
 *
 * Case 作成のように認可対象の Case が存在しない操作でも、
 * WorkContext は認証済みの情報からしか作れないようにしておく。
 */
export class TenantAccess {
  constructor(
    readonly tenantId: string,
    private readonly userId: string,
  ) {}

  get actor(): ActorRef {
    return { type: 'USER', userId: this.userId, agentRunId: null }
  }

  toWorkContext(requestId: string | null, idempotency?: IdempotencyRequest | null): WorkContext {
    return {
      tenantId: this.tenantId,
      actor: this.actor,
      requestId,
      idempotency: idempotency ?? null,
    }
  }
}

/**
 * 認証済み利用者から tenant / Case の権限を導出する。
 *
 * 要求本文の自己申告（ownerName、続柄、role）は一切使わない。
 */
export class AccessService {
  constructor(private readonly read: ReadRepository) {}

  /**
   * トークンの主張を membership で裏取りする。
   *
   * Provider によってはカスタムクレームを利用者側で設定できる。
   * tenant クレームだけを信じると、別 tenant を名乗れてしまう。
   */
  async authenticate(identity: VerifiedIdentity): Promise<AuthenticatedUser> {
    const tenantId = identity.claimedTenantId
    const member = await this.read.get<TenantMember>(tenantId, {
      collection: collections.members,
      caseId: null,
      id: identity.subject,
    })
    if (!member || !member.active) {
      throw errors.forbidden({
        message: 'この利用者に割り当てられた領域がありません。',
        internal: { reason: 'no active tenant membership' },
      })
    }
    return { userId: identity.subject, tenantId }
  }

  /** Case を特定しない操作の文脈。認証済みであることだけが前提。 */
  tenantAccess(user: AuthenticatedUser): TenantAccess {
    return new TenantAccess(user.tenantId, user.userId)
  }

  /**
   * すでに取得済みの membership から認可結果を組み立てる。
   *
   * 一覧のように membership を起点に引いた後、同じ文書をもう一度
   * 読み直さないための入口。権限の判定条件は authorizeCase と同じ。
   */
  accessFromMembership(
    user: AuthenticatedUser,
    member: CaseMember,
    operation: CaseOperation,
  ): CaseAccess {
    if (!member.active || member.userId !== user.userId || member.caseId === null) {
      throw errors.notFound({ internal: { reason: 'membership does not belong to the caller' } })
    }
    const access = new CaseAccess(user.tenantId, member.caseId, member.role, member, user.userId)
    access.assertCan(operation)
    return access
  }

  /**
   * Case ごとの権限を検証する。
   *
   * 非メンバーには NOT_FOUND を返す。FORBIDDEN を返すと、
   * 他人の Case の存在を ID の総当たりで確認できてしまう。
   */
  async authorizeCase(
    user: AuthenticatedUser,
    caseId: string,
    operation: CaseOperation,
  ): Promise<CaseAccess> {
    const member = await this.read.get<CaseMember>(user.tenantId, {
      collection: collections.caseMembers,
      caseId,
      id: user.userId,
    })
    if (!member || !member.active) {
      throw errors.notFound({ internal: { reason: 'not a case member', caseId } })
    }

    const access = new CaseAccess(user.tenantId, caseId, member.role, member, user.userId)
    access.assertCan(operation)
    return access
  }
}
