import type {
  DecisionState,
  InheritanceDecisionEntity,
  InheritanceMethod,
} from '../../domain/decision/inheritance-decision.js'
import { isDecisionConfirmed } from '../../domain/decision/inheritance-decision.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, ReadRepository, UnitOfWork } from '../ports/persistence.js'
import { SERVER_TIME } from '../ports/persistence.js'
import type { InheritanceDecisionReader } from '../task/task-service.js'

export interface DecisionView {
  personId: string
  method: InheritanceMethod | null
  state: DecisionState
  /** 本人が確定したか。制限の解除はこれだけを根拠にする。 */
  confirmed: boolean
  reportedByUserId: string | null
  confirmedByUserId: string | null
  confirmedAt: string | null
  note: string | null
  version: number
  updatedAt: string
}

/** Person ごとに 1 つ。Person の ID をそのまま文書 ID にする。 */
function decisionLocation(caseId: string, personId: string): DocLocation {
  return { collection: collections.decisions, caseId, id: personId }
}

function toDecisionView(entity: InheritanceDecisionEntity): DecisionView {
  return {
    personId: entity.personId,
    method: entity.method,
    state: entity.state,
    confirmed: isDecisionConfirmed(entity),
    reportedByUserId: entity.reportedByUserId,
    confirmedByUserId: entity.confirmedByUserId,
    confirmedAt: entity.confirmedAt,
    note: entity.note,
    version: entity.version,
    updatedAt: entity.updatedAt,
  }
}

/**
 * 相続方法についての本人の意思（仕様書 8 章）。
 *
 * 下書き、本人以外による報告、本人による確定を区別する。
 * 選択欄が埋まっただけで確定として扱うと、他人が本人の意思を決めたことになる。
 */
export class InheritanceDecisionService {
  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** 下書きと報告。本人の確定ではない。 */
  async record(
    user: AuthenticatedUser,
    caseId: string,
    personId: string,
    input: { method: InheritanceMethod | null; state: 'DRAFT' | 'REPORTED'; note?: string | null },
    meta: CommandMeta,
  ): Promise<DecisionView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.get<InheritanceDecisionEntity>(decisionLocation(caseId, personId))

      if (current?.state === 'CONFIRMED') {
        // 本人が確定した意思を、他人の入力で下書きへ戻さない。
        throw errors.preconditionFailed({
          message: 'この方は既にご本人が確定しています。変更はご本人のみ行えます。',
          details: { reason: 'ALREADY_CONFIRMED_BY_SELF' },
        })
      }

      if (!current) {
        tx.create<InheritanceDecisionEntity>(decisionLocation(caseId, personId), {
          id: personId,
          personId,
          method: input.method,
          state: input.state,
          reportedByUserId: user.userId,
          confirmedByUserId: null,
          confirmedAt: null,
          note: input.note ?? null,
        })
      } else {
        tx.update<InheritanceDecisionEntity>(decisionLocation(caseId, personId), current.version, {
          method: input.method,
          state: input.state,
          reportedByUserId: user.userId,
          note: input.note ?? null,
        })
      }

      tx.audit({
        caseId,
        type: 'decision.recorded',
        target: { collection: collections.decisions.name, id: personId, version: (current?.version ?? 0) + 1 },
        detail: { state: input.state, method: input.method },
      })
    })

    return this.get(user, caseId, personId)
  }

  /**
   * 本人による確定。
   *
   * 役割では代替できない。Case の所有者であっても、他の家族の意思を
   * 本人として確定することはできない。
   */
  async confirm(
    user: AuthenticatedUser,
    caseId: string,
    personId: string,
    input: { method: InheritanceMethod; expectedVersion: number; note?: string | null },
    meta: CommandMeta,
  ): Promise<DecisionView> {
    const access = await this.access.authorizeCase(user, caseId, 'decision.confirm.self')
    // membership と Person の紐付けだけを根拠にする。
    access.assertSelf(personId)

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<InheritanceDecisionEntity>(decisionLocation(caseId, personId))
      tx.update<InheritanceDecisionEntity>(decisionLocation(caseId, personId), input.expectedVersion, {
        method: input.method,
        state: 'CONFIRMED',
        confirmedByUserId: user.userId,
        // 確定時刻はサーバーが決める。
        confirmedAt: SERVER_TIME,
        note: input.note ?? current.note,
      })
      tx.audit({
        caseId,
        type: 'decision.confirmed',
        target: { collection: collections.decisions.name, id: personId, version: input.expectedVersion + 1 },
        detail: { method: input.method },
      })
      // 制限の解除は Case 全体に影響する。関係する処理へ通知する。
      tx.outbox({
        type: 'decision.confirmed',
        caseId,
        payload: { caseId, personId, method: input.method },
      })
    })

    return this.get(user, caseId, personId)
  }

  async get(user: AuthenticatedUser, caseId: string, personId: string): Promise<DecisionView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const entity = await this.read.get<InheritanceDecisionEntity>(
      user.tenantId,
      decisionLocation(caseId, personId),
    )
    if (!entity) throw errors.notFound()
    return toDecisionView(entity)
  }

  async list(user: AuthenticatedUser, caseId: string): Promise<DecisionView[]> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<InheritanceDecisionEntity>(
      user.tenantId,
      collections.decisions,
      caseId,
      { limit: 100 },
    )
    return page.items.map(toDecisionView)
  }
}

/**
 * 放棄前ロックの判定（#9 が参照する）。
 *
 * 記録が 1 件も無い状態を「確定済み」にしない。既に登録されている
 * 相続人全員が本人として確定している場合にだけ解除する。
 *
 * 相続人の範囲そのものは Person の登録（#13）に依存する。Person が
 * 未登録の Case では確定と判定されない。
 */
export class StoredInheritanceDecisionReader implements InheritanceDecisionReader {
  constructor(private readonly read: ReadRepository) {}

  async isConfirmed(tenantId: string, caseId: string): Promise<boolean> {
    const page = await this.read.list<InheritanceDecisionEntity>(tenantId, collections.decisions, caseId, {
      limit: 100,
    })
    if (page.items.length === 0) return false
    return page.items.every(isDecisionConfirmed)
  }
}
