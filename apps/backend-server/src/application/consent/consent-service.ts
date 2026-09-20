import { createHash } from 'node:crypto'
import type {
  ConsentCatalog,
  ConsentDocumentDefinition,
  ConsentKind,
  ConsentRecord,
} from '../../domain/consent/consent.js'
import { MAX_HISTORY_ENTRIES, isSatisfied } from '../../domain/consent/consent.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService } from '../authorization/case-access.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { CommandMeta } from '../case/case-service.js'
import type { DocLocation, ReadRepository, Tx, UnitOfWork } from '../ports/persistence.js'
import { SERVER_TIME } from '../ports/persistence.js'

export interface ConsentDocumentView extends ConsentDocumentDefinition {
  agreedVersion: string | null
  agreedAt: string | null
  /** 現在の版に対して有効な同意があるか。 */
  satisfied: boolean
}

export interface ConsentStatusView {
  documents: ConsentDocumentView[]
  /** 必須のうち、未同意または版ずれがあるか。 */
  outstanding: boolean
}

/**
 * 同意の有無から何が使えるかを判定した結果。
 *
 * 拒否するときは理由と、その状態でも使える機能を返す。
 * 「使えない」とだけ返すと、利用者は手動管理まで諦めてしまう。
 */
export interface ConsentPolicyDecision {
  /** 手動での案件・書類・手続き管理を使えるか。 */
  manualManagement: boolean
  /** 外部 AI へデータを提供する処理を起動してよいか。 */
  externalAi: boolean
  missingRequired: ConsentKind[]
  missingOptional: ConsentKind[]
}

function recordDocId(userId: string, kind: ConsentKind): string {
  // 利用者 ID の字種は Provider 次第なので、そのままパスに使わない。
  return createHash('sha256').update(`${userId.length}:${userId}/${kind}`).digest('hex')
}

function recordLocation(userId: string, kind: ConsentKind): DocLocation {
  return { collection: collections.consents, caseId: null, id: recordDocId(userId, kind) }
}

export class ConsentService {
  constructor(
    private readonly catalog: ConsentCatalog,
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
  ) {}

  private definition(kind: ConsentKind): ConsentDocumentDefinition {
    const found = this.catalog.documents.find((document) => document.kind === kind)
    if (!found) {
      throw errors.validationFailed({
        message: '指定された同意文書は存在しません。',
        details: { kind },
      })
    }
    return found
  }

  private async records(user: AuthenticatedUser, tx?: Tx): Promise<Map<ConsentKind, ConsentRecord | null>> {
    const entries = await Promise.all(
      this.catalog.documents.map(
        async (document) =>
          [
            document.kind,
            await (tx ? tx.get<ConsentRecord>(recordLocation(user.userId, document.kind))
              : this.read.get<ConsentRecord>(user.tenantId, recordLocation(user.userId, document.kind))),
          ] as const,
      ),
    )
    return new Map(entries)
  }

  async status(user: AuthenticatedUser, tx?: Tx): Promise<ConsentStatusView> {
    const records = await this.records(user, tx)
    const documents = this.catalog.documents.map((definition) => {
      const record = records.get(definition.kind) ?? null
      return {
        ...definition,
        agreedVersion: record?.agreedVersion ?? null,
        agreedAt: record?.agreedAt ?? null,
        satisfied: isSatisfied(record, definition),
      }
    })
    return {
      documents,
      outstanding: documents.some((document) => document.required && !document.satisfied),
    }
  }

  /**
   * 同意を記録する。
   *
   * 版を指定させ、クライアントが「最新に同意した」と主張するだけでは
   * 通らないようにする。表示していない版への同意を防ぐため。
   */
  async agree(
    user: AuthenticatedUser,
    agreements: { kind: ConsentKind; version: string }[],
    meta: CommandMeta,
  ): Promise<ConsentStatusView> {
    const tenant = this.access.tenantAccess(user)

    await this.uow.run(tenant.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      for (const agreement of agreements) {
        const definition = this.definition(agreement.kind)
        if (agreement.version !== definition.version) {
          // 存在しない版や古い版への同意を受け付けない。
          throw errors.conflict({
            message: '同意文書が更新されています。最新の内容を確認してからやり直してください。',
            details: { kind: agreement.kind, currentVersion: definition.version },
          })
        }

        const location = recordLocation(user.userId, agreement.kind)
        const current = await tx.get<ConsentRecord>(location)
        const entry = { action: 'AGREED' as const, version: definition.version }

        if (!current) {
          tx.create<ConsentRecord>(location, {
            id: location.id,
            userId: user.userId,
            kind: agreement.kind,
            agreedVersion: definition.version,
            // 同意時刻はサーバーが決める。プロセスの時計を使わない。
            agreedAt: SERVER_TIME,
            history: [entry],
          })
        } else {
          if (current.userId !== user.userId) {
            // 他人の同意記録を書き換えられないことを、保存側でも確かめる。
            throw errors.forbidden({ internal: { reason: 'consent record belongs to another user' } })
          }
          tx.update<ConsentRecord>(location, current.version, {
            agreedVersion: definition.version,
            agreedAt: SERVER_TIME,
            history: [...current.history, entry].slice(-MAX_HISTORY_ENTRIES),
          })
        }

        tx.audit({
          caseId: null,
          type: 'consent.agreed',
          target: { collection: collections.consents.name, id: location.id, version: (current?.version ?? 0) + 1 },
          detail: { kind: agreement.kind, version: definition.version },
        })
      }
    })

    return this.status(user)
  }

  /**
   * 同意の撤回。
   *
   * 必須の同意を撤回した場合、業務 API は使えなくなる。
   * 撤回は以後の提供を止めるものであり、送信済みのデータを
   * 回収できたことを意味しない。
   */
  async revoke(user: AuthenticatedUser, kind: ConsentKind, meta: CommandMeta): Promise<ConsentStatusView> {
    const tenant = this.access.tenantAccess(user)
    const definition = this.definition(kind)

    await this.uow.run(tenant.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const location = recordLocation(user.userId, kind)
      const current = await tx.get<ConsentRecord>(location)
      if (!current || current.agreedVersion === null) {
        // 同意していない状態への撤回は何もしない。再送で失敗させない。
        return
      }
      if (current.userId !== user.userId) {
        throw errors.forbidden({ internal: { reason: 'consent record belongs to another user' } })
      }

      const entry = { action: 'REVOKED' as const, version: current.agreedVersion }
      tx.update<ConsentRecord>(location, current.version, {
        agreedVersion: null,
        agreedAt: null,
        history: [...current.history, entry].slice(-MAX_HISTORY_ENTRIES),
      })

      tx.audit({
        caseId: null,
        type: 'consent.revoked',
        target: { collection: collections.consents.name, id: location.id, version: current.version + 1 },
        detail: { kind, revokedVersion: entry.version, definitionVersion: definition.version },
      })

      // 待機中の処理へ「これ以上送らない」ことを伝える。配送は #10。
      tx.outbox({
        type: 'consent.revoked',
        caseId: null,
        payload: { userId: user.userId, kind },
      })
    })

    return this.status(user)
  }

  /**
   * 現在の同意から何が使えるかを判定する。
   *
   * 任意の外部 AI 同意が無くても、必須同意があれば手動管理は使える。
   * 機能全体を止めない。
   */
  async policy(user: AuthenticatedUser, tx?: Tx): Promise<ConsentPolicyDecision> {
    const status = await this.status(user, tx)
    const missingRequired = status.documents
      .filter((document) => document.required && !document.satisfied)
      .map((document) => document.kind)
    const missingOptional = status.documents
      .filter((document) => !document.required && !document.satisfied)
      .map((document) => document.kind)

    return {
      manualManagement: missingRequired.length === 0,
      externalAi: missingRequired.length === 0 && !missingOptional.includes('CROSS_BORDER_AI'),
      missingRequired,
      missingOptional,
    }
  }

  /** 必須同意が揃っていなければ業務 API を止める。 */
  async assertBasicConsent(user: AuthenticatedUser): Promise<void> {
    const decision = await this.policy(user)
    if (decision.manualManagement) return
    throw errors.consentRequired({
      details: {
        missingRequired: decision.missingRequired,
        // 同意を取り直すための API は使えることを示す。
        availableOperations: ['getConsents', 'agreeConsents'],
      },
    })
  }

  /**
   * 外部 AI へデータを提供する処理の可否。
   *
   * 拒否のときも、その状態で使える機能を理由に添える。
   */
  async assertExternalAiAllowed(user: AuthenticatedUser, tx?: Tx): Promise<void> {
    const decision = await this.policy(user, tx)
    if (decision.externalAi) return
    throw errors.consentRequired({
      message: '外部AIを利用する処理には追加の同意が必要です。手動での管理は引き続き利用できます。',
      details: {
        missingRequired: decision.missingRequired,
        missingOptional: decision.missingOptional,
        availableFeatures: ['manual-case-management', 'manual-document-management', 'task-management'],
      },
    })
  }
}
