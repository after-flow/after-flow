import { randomUUID } from 'node:crypto'
import type { CaseAction, CaseProfileResource, CaseResource } from '@aftercare/public-contracts'
import type { CaseEntity } from '../../domain/case/case.js'
import { nextCaseVersion } from '../../domain/case/case.js'
import { businessToday, findCaseDateIssues, type CaseDateIssue } from '../../domain/case/case-dates.js'
import type { CaseProfile, ProfileInput } from '../../domain/case/case-profile.js'
import { normalizeProfile } from '../../domain/case/case-profile.js'
import type { ProcedureFacts } from '../../domain/case/case-profile.js'
import { roleAllows } from '../../domain/authorization/case-role.js'
import type { TenantMember } from '../authorization/case-access.js'
import type { CaseMember } from '../../domain/authorization/case-role.js'
import { collections } from '../../domain/shared/collections.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { createPerson, defaultRoleFor, newPersonId, type Person } from '../../domain/person/person.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService, CaseAccess } from '../authorization/case-access.js'
import type { Clock } from '../ports.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type {
  DocLocation,
  IdempotencyRequest,
  Page,
  ReadRepository,
  UnitOfWork,
} from '../ports/persistence.js'
import { EMPTY_PREPARATION, ProcedureSyncService } from '../task/procedure-sync-service.js'

/**
 * 作成時に、作成者本人を Person として同じ Transaction で同時登録する指定。
 * 省略・null なら登録しない（従来どおり後から POST /cases/:caseId/persons で登録する）。
 */
export interface OwnerPersonInput {
  /** true → role HEIR_CANDIDATE、false → RELATED（既存 createPerson の既定と同じ） */
  isHeir: boolean
}

export interface CreateCaseInput {
  deceasedName: string
  deceasedNameKana?: string | null
  dateOfDeath: string
  dateOfBirth?: string | null
  knownAt?: string | null
  ownerName: string
  relationshipToDeceased: string
  municipality?: string | null
  ownerPerson?: OwnerPersonInput | null
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
  funeralCompletedAt?: string | null
  /** 丸ごと置換。省略項目は UNKNOWN に正規化される。null で未回答に戻す。キー省略は変更なし。 */
  profile?: ProfileInput | null
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

function personLocation(caseId: string, personId: string): DocLocation {
  return { collection: collections.persons, caseId, id: personId }
}

/**
 * 日付の整合を検証し、違反があれば 400 VALIDATION_FAILED を投げる。
 *
 * Domain（`findCaseDateIssues`）は純粋な判定だけを返し、`source: 'body'` の
 * ような presentation の語彙（route の Zod 検証と同じ details 形）への整形は
 * ここ Application で行う。
 */
export function assertCaseDatesValid(
  dates: { dateOfDeath: string; knownAt: string | null; dateOfBirth?: string | null },
  today: string,
): void {
  const issues: CaseDateIssue[] = findCaseDateIssues(dates, today)
  if (issues.length > 0) {
    throw errors.validationFailed({
      message: '日付の指定が正しくありません。',
      details: { source: 'body', issues },
    })
  }
}

/**
 * 公開 DTO への変換。
 *
 * 許可された操作はサーバーが判定して返す。フロントが役割から
 * 推測すると、画面と Backend の判断がずれる。
 */
function toCaseProfileResource(profile: CaseProfile): CaseProfileResource {
  return {
    healthInsurance: profile.healthInsurance,
    pension: profile.pension,
    occupation: profile.occupation,
    realEstate: profile.realEstate,
    car: profile.car,
    mortgage: profile.mortgage,
    answeredAt: profile.answeredAt,
  }
}

/** 正規化後の深い等価比較。answeredAt だけ違っても差分として扱う（洗い出しの plan は no-op になる）。 */
function profileEquals(a: CaseProfile | null, b: CaseProfile | null): boolean {
  if (a === null || b === null) return a === b
  return a.healthInsurance === b.healthInsurance && a.pension === b.pension && a.occupation === b.occupation
    && a.realEstate === b.realEstate && a.car === b.car && a.mortgage === b.mortgage && a.answeredAt === b.answeredAt
}

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
    // 未回答（null/欠落）ならキー自体を出さない。
    ...(entity.profile ? { profile: toCaseProfileResource(entity.profile) } : {}),
    ownerName: entity.ownerName,
    relationshipToDeceased: entity.relationshipToDeceased,
    municipality: entity.municipality,
    funeralCompletedAt: entity.funeralCompletedAt ?? null,
    ownerPersonId: entity.ownerPersonId ?? null,
    // membership 由来。assertSelf と同じ根拠を FE に見せる。
    selfPersonId: access.member.personId,
    aiPlanningRestriction: entity.aiPlanningRestriction ?? null,
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
    private readonly clock: Clock = { now: () => new Date().toISOString() },
    private readonly procedureSync: ProcedureSyncService,
  ) {}

  /**
   * Case を作成し、作成者の membership を同じ Transaction で確定する。
   *
   * 別々に保存すると、membership の書き込みに失敗したときに
   * 誰も触れない Case が残る。`ownerPerson` を指定すると、作成者本人を
   * Person としても同じ Transaction で登録し、Case.ownerPersonId と
   * membership.personId の両方に紐付ける。
   */
  async create(user: AuthenticatedUser, input: CreateCaseInput, meta: CommandMeta): Promise<CaseResource> {
    const tenant = this.access.tenantAccess(user)
    const caseId = randomUUID()
    const ownerPersonId = input.ownerPerson ? newPersonId() : null

    // 書き込み前に弾く。何も残さずに 400 を返す。
    assertCaseDatesValid(
      { dateOfDeath: input.dateOfDeath, knownAt: input.knownAt ?? null, dateOfBirth: input.dateOfBirth ?? null },
      businessToday(new Date(this.clock.now())),
    )

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
          ownerPersonId,
          profile: null,
          aiPlanningRestriction: null,
          status: 'ACTIVE',
          caseVersion: 1,
        }
        tx.create<CaseEntity>(caseLocation(caseId), { id: caseId, ...created })

        if (ownerPersonId && input.ownerPerson) {
          const now = this.clock.now()
          const person: Person = createPerson(
            { id: ownerPersonId, tenantId: tenant.tenantId, caseId, actor: { kind: 'USER', id: user.userId }, now },
            {
              name: input.ownerName,
              nameKana: null,
              relationshipLabel: input.relationshipToDeceased,
              role: defaultRoleFor(input.ownerPerson.isHeir),
              isHeir: input.ownerPerson.isHeir,
              dateOfBirth: null,
              specialCircumstance: null,
              contact: null,
              note: null,
            },
          )
          // tenantId/caseId/version/createdAt/updatedAt は Tx.create が確定する。
          // createdBy/updatedBy/excludedAt/excludedBy/exclusionReason は残す。
          const { id, tenantId: _tenantId, caseId: _caseId, version: _version,
            createdAt: _createdAt, updatedAt: _updatedAt, ...personData } = person
          tx.create<Person & EntityBase>(personLocation(caseId, ownerPersonId), { id, ...personData })
        }

        tx.create<CaseMember>(memberLocation(caseId, user.userId), {
          id: user.userId,
          userId: user.userId,
          role: 'OWNER',
          active: true,
          // 本人フラグ付き作成では ownerPersonId をそのまま紐付ける。
          // それ以外の紐付けは #13 が登録する。
          personId: ownerPersonId,
        })

        tx.audit({
          caseId,
          type: 'case.created',
          target: { collection: collections.cases.name, id: caseId, version: 1 },
          detail: { municipality: created.municipality, ownerPersonId },
        })

        if (ownerPersonId) {
          tx.audit({
            caseId,
            type: 'person.created',
            target: { collection: 'Person', id: ownerPersonId, version: null },
            detail: { source: 'CASE_CREATION' },
          })
        }

        // Outbox の case.created は補正経路（Outbox worker の再同期）として残す。
        // 初期手続き・期限の生成は下の procedureSync.apply が同じ tx で行う。
        tx.outbox({
          type: 'case.created',
          caseId,
          payload: { caseId, dateOfDeath: created.dateOfDeath, knownAt: created.knownAt },
        })

        const facts: ProcedureFacts & { caseId: string } = {
          caseId,
          dateOfDeath: created.dateOfDeath,
          knownAt: created.knownAt,
          dateOfBirth: created.dateOfBirth,
          profile: created.profile ?? null,
        }
        await this.procedureSync.apply(tx, facts, EMPTY_PREPARATION, 'CASE_CREATED')

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
    // Firestore の再試行で毎回別の「今日」にならないよう、tx の外で 1 回だけ算出する。
    const today = businessToday(new Date(this.clock.now()))
    // 洗い出しの prepare（evidence・依存関係・legacy Deadline ID の検索）は tx の外で行う。
    // 入力にこれらのキーが無ければ洗い出しは走らないため、prepare も省略してよい。
    const touchesProcedureFacts = ['dateOfDeath', 'knownAt', 'dateOfBirth', 'profile']
      .some((key) => key in input)
    const prep = touchesProcedureFacts ? await this.procedureSync.prepare(user.tenantId, caseId) : EMPTY_PREPARATION

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

      // 日付を触らない PATCH では legacy の日付不整合 Case を巻き込まない。
      if ('dateOfDeath' in patch || 'knownAt' in patch || 'dateOfBirth' in patch) {
        assertCaseDatesValid(
          {
            dateOfDeath: patch.dateOfDeath ?? current.dateOfDeath,
            knownAt: 'knownAt' in patch ? (patch.knownAt ?? null) : current.knownAt,
            dateOfBirth: 'dateOfBirth' in patch ? (patch.dateOfBirth ?? null) : (current.dateOfBirth ?? null),
          },
          today,
        )
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

      // 起算日が変われば期限の再評価が要る。
      if ('dateOfDeath' in patch || 'knownAt' in patch) {
        tx.outbox({
          type: 'case.reference_dates_changed',
          caseId,
          payload: { caseId, dateOfDeath: patch.dateOfDeath ?? current.dateOfDeath, knownAt: patch.knownAt ?? current.knownAt },
        })
      }
      if ('profile' in patch || 'dateOfBirth' in patch) {
        tx.outbox({ type: 'case.profile_changed', caseId, payload: { caseId } })
      }

      // profile / dateOfBirth / dateOfDeath / knownAt の変更で手続きを洗い出し直す（同じ tx）。
      if ('dateOfDeath' in patch || 'knownAt' in patch || 'dateOfBirth' in patch || 'profile' in patch) {
        const facts: ProcedureFacts & { caseId: string } = {
          caseId,
          dateOfDeath: patch.dateOfDeath ?? current.dateOfDeath,
          knownAt: 'knownAt' in patch ? (patch.knownAt ?? null) : current.knownAt,
          dateOfBirth: 'dateOfBirth' in patch ? (patch.dateOfBirth ?? null) : (current.dateOfBirth ?? null),
          profile: 'profile' in patch ? (patch.profile ?? null) : (current.profile ?? null),
        }
        await this.procedureSync.apply(tx, facts, prep, 'CASE_UPDATED')
      }
    })

    return toCaseResource(await this.requireCase(user.tenantId, caseId), access)
  }

  /** Owner-only command; reasons are data, never instructions for the Agent. */
  async setPlanningRestriction(user: AuthenticatedUser, caseId: string, expectedVersion: number,
    restriction: { reason: string } | null, meta: CommandMeta): Promise<CaseResource> {
    const access = await this.access.authorizeCase(user, caseId, 'case.administer')
    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async tx => {
      const member = await tx.get<CaseMember>(memberLocation(caseId, user.userId))
      const tenant = await tx.get<TenantMember>({ collection: collections.members, caseId: null, id: user.userId })
      if (!member?.active || member.userId !== user.userId || !roleAllows(member.role, 'case.administer')
        || !tenant?.active || tenant.userId !== user.userId) throw errors.forbidden()
      const current = await tx.require<CaseEntity>(caseLocation(caseId))
      if (current.version !== expectedVersion) throw errors.conflict()
      if (current.status !== 'ACTIVE') throw errors.preconditionFailed()
      const normalized = restriction === null ? null : { reason: restriction.reason.trim() }
      if (normalized && (!normalized.reason || normalized.reason.length > 1000)) throw errors.validationFailed()
      if ((current.aiPlanningRestriction?.reason ?? null) === (normalized?.reason ?? null)) return
      tx.update<CaseEntity>(caseLocation(caseId), expectedVersion, {
        aiPlanningRestriction: normalized, caseVersion: nextCaseVersion(current.caseVersion),
      })
      tx.audit({ caseId, type: 'case.ai_planning_restriction_changed',
        target: { collection: collections.cases.name, id: caseId, version: expectedVersion + 1 },
        detail: { restricted: normalized !== null } })
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
  assign('funeralCompletedAt')
  if ('profile' in input) {
    const normalized: CaseProfile | null = input.profile == null ? null : normalizeProfile(input.profile)
    if (!profileEquals(current.profile ?? null, normalized)) patch.profile = normalized
  }
  return patch
}
