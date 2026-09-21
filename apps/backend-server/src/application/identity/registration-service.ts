import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { TenantMember } from '../authorization/case-access.js'
import type { VerifiedIdentity } from '../ports/identity.js'
import type { DocLocation, IdempotencyRequest, ReadRepository, UnitOfWork } from '../ports/persistence.js'

export interface MeView {
  userId: string
  tenantId: string
  registered: boolean
  active: boolean
  emailVerified: boolean
  registeredAt: string | null
}

function memberLocation(userId: string): DocLocation {
  return { collection: collections.members, caseId: null, id: userId }
}

/**
 * 利用者登録（`POST /me`）。
 *
 * ADR 0001 §2「所属・権限の付与と変更は Backend が制御する」の中核。
 * 認証 middleware では書き込まず、この Service を唯一の登録経路にする。
 * 監査・冪等性・Transaction の規約を middleware の外に置いたまま保つため。
 */
export class RegistrationService {
  constructor(
    /** 配備単位で固定した tenant（`AUTH_TENANT_ID`）。 */
    private readonly tenantId: string,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** 副作用の無い現況確認。未登録・停止済みでも 200 で状態を返す（route 側で判定する）。 */
  async get(identity: VerifiedIdentity): Promise<MeView> {
    const member = await this.read.get<TenantMember>(this.tenantId, memberLocation(identity.subject))
    return this.toView(identity, member)
  }

  /**
   * 初回登録。既に membership があれば新規作成せず、その状態をそのまま返す
   * （自身が冪等）。`active:false` は登録済みとして扱い、403 への変換は
   * 呼び出し側（route）が行う。
   */
  async register(
    identity: VerifiedIdentity,
    requestId: string | null,
    idempotency: IdempotencyRequest | null,
  ): Promise<{ view: MeView; created: boolean }> {
    let created = false
    await this.uow.run(
      {
        tenantId: this.tenantId,
        actor: { type: 'USER', userId: identity.subject, agentRunId: null },
        requestId,
        idempotency,
      },
      async (tx) => {
        const existing = await tx.get<TenantMember>(memberLocation(identity.subject))
        if (existing) return
        created = true
        tx.create<TenantMember>(memberLocation(identity.subject), {
          id: identity.subject,
          userId: identity.subject,
          active: true,
        })
        // 所属の付与そのものを監査する。ログだけでは監査の代替にならない。
        tx.audit({
          caseId: null,
          type: 'member.registered',
          target: { collection: collections.members.name, id: identity.subject, version: 1 },
          detail: {},
        })
      },
    )

    const member = await this.read.get<TenantMember>(this.tenantId, memberLocation(identity.subject))
    if (!member) {
      throw errors.internal({ internal: { reason: 'tenant member missing immediately after registration' } })
    }
    return { view: this.toView(identity, member), created }
  }

  private toView(identity: VerifiedIdentity, member: TenantMember | null): MeView {
    return {
      userId: identity.subject,
      tenantId: this.tenantId,
      registered: member !== null,
      active: member?.active ?? false,
      // メールアドレスは保存・応答しない（最小化）。確認済みかどうかだけ渡す。
      emailVerified: identity.emailVerified,
      registeredAt: member?.createdAt ?? null,
    }
  }
}
