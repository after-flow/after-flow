import { randomUUID } from 'node:crypto'
import type { CaseAction, CaseResource } from '@aftercare/public-contracts'
import type { CaseEntity } from '../../domain/case/case.js'
import { nextCaseVersion } from '../../domain/case/case.js'
import type { CaseMember } from '../../domain/authorization/case-role.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService, CaseAccess } from '../authorization/case-access.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type {
  DocLocation,
  IdempotencyRequest,
  Page,
  ReadRepository,
  UnitOfWork,
} from '../ports/persistence.js'

export interface CreateCaseInput {
  deceasedName: string
  deceasedNameKana?: string | null
  dateOfDeath: string
  dateOfBirth?: string | null
  knownAt?: string | null
  ownerName: string
  relationshipToDeceased: string
  municipality?: string | null
}

/** 基本情報の訂正。status はここから変更できない。 */
export interface UpdateCaseInput {
  deceasedName?: string
  deceasedNameKana?: string | null
  dateOfDeath?: string
  dateOfBirth?: string | null
  knownAt?: string | null
  ownerName?: string
  relationshipToDeceased?: string
  municipality?: string | null
}

export interface CommandMeta {
  requestId: string | null
  idempotency: IdempotencyRequest | null
}

function caseLocation(id: string): DocLocation {
  return { collection: collections.cases, caseId: null, id }
}

function memberLocation(caseId: string, userId: string): DocLocation {
  return { collection: collections.caseMembers, caseId, id: userId }
}

/**
 * 公開 DTO への変換。
 *
 * 許可された操作はサーバーが判定して返す。フロントが役割から
 * 推測すると、画面と Backend の判断がずれる。
 */
export function toCaseResource(entity: CaseEntity, access: CaseAccess): CaseResource {
  const allowedActions: CaseAction[] = []
  if (access.can('case.write')) allowedActions.push('UPDATE_BASIC_INFO')
  if (access.can('case.administer')) allowedActions.push('ADMINISTER')

  return {
    id: entity.id,
    deceasedName: entity.deceasedName,
    deceasedNameKana: entity.deceasedNameKana,
    dateOfDeath: entity.dateOfDeath,
    dateOfBirth: entity.dateOfBirth,
    knownAt: entity.knownAt,
    ownerName: entity.ownerName,
    relationshipToDeceased: entity.relationshipToDeceased,
    municipality: entity.municipality,
    status: entity.status,
    version: entity.version,
    caseVersion: entity.caseVersion,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    allowedActions,
  }
}

export class CaseService {
  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Case を作成し、作成者の membership を同じ Transaction で確定する。
   *
   * 別々に保存すると、membership の書き込みに失敗したときに
   * 誰も触れない Case が残る。
   */
  async create(user: AuthenticatedUser, input: CreateCaseInput, meta: CommandMeta): Promise<CaseResource> {
    const tenant = this.access.tenantAccess(user)
    const caseId = randomUUID()

    const entity = await this.uow.run(
      tenant.toWorkContext(meta.requestId, meta.idempotency),
      async (tx) => {
        const created: Omit<CaseEntity, keyof import('../../domain/shared/entity.js').EntityBase> = {
          deceasedName: input.deceasedName,
          deceasedNameKana: input.deceasedNameKana ?? null,
          dateOfDeath: input.dateOfDeath,
          dateOfBirth: input.dateOfBirth ?? null,
          // 不明な起算日を死亡日で黙って補完しない。
          knownAt: input.knownAt ?? null,
          ownerName: input.ownerName,
          relationshipToDeceased: input.relationshipToDeceased,
          municipality: input.municipality ?? null,
          status: 'ACTIVE',
          caseVersion: 1,
        }
        tx.create<CaseEntity>(caseLocation(caseId), { id: caseId, ...created })

        tx.create<CaseMember>(memberLocation(caseId, user.userId), {
          id: user.userId,
          userId: user.userId,
          role: 'OWNER',
          active: true,
          // Person との紐付けは #13 が登録する。作成しただけでは本人確認にならない。
          personId: null,
        })

        tx.audit({
          caseId,
          type: 'case.created',
          target: { collection: collections.cases.name, id: caseId, version: 1 },
          detail: { municipality: created.municipality },
        })

        // 初期手続きと期限の生成は #9。配送は #10。ここでは事実だけを残す。
        tx.outbox({
          type: 'case.created',
          caseId,
          payload: { caseId, dateOfDeath: created.dateOfDeath, knownAt: created.knownAt },
        })

        return { caseId, ...created }
      },
    )

    // 冪等な再送では保存済みの結果が返る。改めて権限を取り直して DTO を作る。
    const access = await this.access.authorizeCase(user, entity.caseId, 'case.read')
    const saved = await this.requireCase(user.tenantId, entity.caseId)
    return toCaseResource(saved, access)
  }

  async get(user: AuthenticatedUser, caseId: string): Promise<CaseResource> {
    const access = await this.access.authorizeCase(user, caseId, 'case.read')
    return toCaseResource(await this.requireCase(user.tenantId, caseId), access)
  }

  /**
   * 自分がメンバーである Case だけを返す。
   *
   * Case 本体を先に走査して権限で絞ると、権限の無い Case の件数や
   * 並び順が漏れる。membership を起点に引く。
   */
  async list(
    user: AuthenticatedUser,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<CaseResource>> {
    const memberships = await this.read.listGroup<CaseMember>(user.tenantId, collections.caseMembers, {
      limit: options.limit,
      cursor: options.cursor,
      where: [
        { field: 'userId', op: '==', value: user.userId },
        { field: 'active', op: '==', value: true },
      ],
      orderBy: { field: 'updatedAt', direction: 'desc' },
      // 同じ更新時刻の membership を割る。tenant と userId で絞った中では一意。
      tiebreakField: 'caseId',
    })

    const items: CaseResource[] = []
    for (const membership of memberships.items) {
      if (membership.caseId === null) continue
      const entity = await this.read.get<CaseEntity>(user.tenantId, caseLocation(membership.caseId))
      // membership だけが残った Case は一覧に出さない。件数は欠けるが、
      // 存在しない Case を一覧に並べるより安全。
      if (!entity) continue
      // 取得済みの membership から権限を組み立てる。同じ文書を読み直さない。
      items.push(toCaseResource(entity, this.access.accessFromMembership(user, membership, 'case.read')))
    }

    return memberships.nextCursor === undefined
      ? { items }
      : { items, nextCursor: memberships.nextCursor }
  }

  /**
   * 基本情報の訂正。
   *
   * status は受け取らない。終了・再開は別の操作として扱う。
   * 任意の PATCH で状態を書き換えられると、状態遷移の検証が意味を失う。
   */
  async update(
    user: AuthenticatedUser,
    caseId: string,
    expectedVersion: number,
    input: UpdateCaseInput,
    meta: CommandMeta,
  ): Promise<CaseResource> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<CaseEntity>(caseLocation(caseId))
      if (current.status !== 'ACTIVE') {
        throw errors.preconditionFailed({
          message: '終了した案件の基本情報は変更できません。',
          details: { status: current.status },
        })
      }

      const patch = buildPatch(current, input)
      if (Object.keys(patch).length === 0) {
        // 変更が無い要求で版だけを進めない。AI の提案を無意味に stale にしないため。
        return
      }

      tx.update<CaseEntity>(caseLocation(caseId), expectedVersion, {
        ...patch,
        // 起算日に影響する変更があるため、Context の版も進める。
        caseVersion: nextCaseVersion(current.caseVersion),
      })

      tx.audit({
        caseId,
        type: 'case.basic_info_updated',
        target: { collection: collections.cases.name, id: caseId, version: expectedVersion + 1 },
        detail: { changed: Object.keys(patch) },
      })

      // 起算日が変われば期限の再評価が要る。判定は #9 が行う。
      if ('dateOfDeath' in patch || 'knownAt' in patch) {
        tx.outbox({
          type: 'case.reference_dates_changed',
          caseId,
          payload: { caseId, dateOfDeath: patch.dateOfDeath ?? current.dateOfDeath, knownAt: patch.knownAt ?? current.knownAt },
        })
      }
    })

    return toCaseResource(await this.requireCase(user.tenantId, caseId), access)
  }

  private async requireCase(tenantId: string, caseId: string): Promise<CaseEntity> {
    const entity = await this.read.get<CaseEntity>(tenantId, caseLocation(caseId))
    if (!entity) throw errors.notFound()
    return entity
  }
}

/** 実際に値が変わる項目だけを patch にする。 */
function buildPatch(current: CaseEntity, input: UpdateCaseInput): Partial<CaseEntity> {
  const patch: Partial<CaseEntity> = {}
  const assign = <K extends keyof UpdateCaseInput & keyof CaseEntity>(key: K) => {
    if (!(key in input)) return
    const value = (input[key] ?? null) as CaseEntity[K]
    if (current[key] !== value) patch[key] = value
  }
  assign('deceasedName')
  assign('deceasedNameKana')
  assign('dateOfDeath')
  assign('dateOfBirth')
  assign('knownAt')
  assign('ownerName')
  assign('relationshipToDeceased')
  assign('municipality')
  return patch
}
