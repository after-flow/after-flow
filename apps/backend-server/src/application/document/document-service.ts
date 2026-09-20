import { createHash, randomUUID } from 'node:crypto'
import { assertSupportedDocument } from '../../domain/document/content-type.js'
import type { DocumentEntity, DocumentKind } from '../../domain/document/document.js'
import { isInspectionComplete } from '../../domain/document/inspection.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService, CaseAccess } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { ConsentService } from '../consent/consent-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocumentInspector } from '../ports/inspection.js'
import type { ObjectStorage } from '../ports/object-storage.js'
import type { DocLocation, ListOptions, Page, ReadRepository, UnitOfWork } from '../ports/persistence.js'

export interface RegisterDocumentInput {
  fileName: string
  declaredContentType: string
  content: Uint8Array
  kind: DocumentKind
}

/** 解析を受け付けられない理由。画面はこれを見て導線を出し分ける。 */
export type AnalysisBlockedReason =
  /** 検査が完了して合格していない。 */
  | 'INSPECTION_NOT_PASSED'
  /** AI が接続されていない。 */
  | 'AI_NOT_CONNECTED'
  /** 外部 AI への提供同意が無い。 */
  | 'CONSENT_REQUIRED'

export interface DocumentView {
  id: string
  caseId: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  kind: DocumentKind
  kindSource: 'MANUAL' | 'AI'
  storageState: DocumentEntity['storageState']
  inspection: {
    status: DocumentEntity['inspection']['status']
    /** 検査が終わっているか。合格とは別。 */
    completed: boolean
    findings: DocumentEntity['inspection']['findings']
  }
  analysis: {
    state: DocumentEntity['analysisState']
    agentRunId: string | null
    canRequest: boolean
    blockedReasons: AnalysisBlockedReason[]
  }
  archived: boolean
  archivedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

function documentLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.documents, caseId, id }
}

/**
 * 文書 ID を冪等性キーから決める。
 *
 * 保存の途中で失敗した再送が、同じ文書を指して続きから進められるようにする。
 * Transaction の冪等性記録だけに頼ると、原本を置く前の状態が結果として
 * 確定し、再送しても完了できない。
 */
function documentIdFrom(caseId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${caseId.length}:${caseId}/${idempotencyKey}`).digest('hex').slice(0, 32)
}

function objectKeyFor(tenantId: string, caseId: string, documentId: string): string {
  return `tenants/${tenantId}/cases/${caseId}/documents/${documentId}`
}

export class DocumentService {
  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    private readonly storage: ObjectStorage,
    private readonly consent: ConsentService,
    /**
     * 検査実装。未設定なら検査は行われず、状態は PENDING のままになる。
     * 未検査を合格として扱わない（ADR 0002）。
     */
    private readonly inspector: DocumentInspector | null,
    /** AI が接続されているか。#10 が接続したときに true になる。 */
    private readonly aiConnected: boolean = false,
  ) {}

  private async toView(user: AuthenticatedUser, entity: DocumentEntity): Promise<DocumentView> {
    const blockedReasons: AnalysisBlockedReason[] = []
    if (entity.inspection.status !== 'PASSED') blockedReasons.push('INSPECTION_NOT_PASSED')
    if (!this.aiConnected) blockedReasons.push('AI_NOT_CONNECTED')
    const policy = await this.consent.policy(user)
    if (!policy.externalAi) blockedReasons.push('CONSENT_REQUIRED')

    return {
      id: entity.id,
      caseId: entity.caseId ?? '',
      fileName: entity.fileName,
      contentType: entity.contentType,
      sizeBytes: entity.sizeBytes,
      sha256: entity.sha256,
      kind: entity.kind,
      kindSource: entity.kindSource,
      storageState: entity.storageState,
      inspection: {
        status: entity.inspection.status,
        completed: isInspectionComplete(entity.inspection.status),
        findings: entity.inspection.findings,
      },
      analysis: {
        state: entity.analysisState,
        agentRunId: entity.agentRunId,
        canRequest: blockedReasons.length === 0,
        blockedReasons,
      },
      archived: entity.archived,
      archivedAt: entity.archivedAt,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    }
  }

  /**
   * 原本を登録する。
   *
   * Storage と Firestore は原子的に書けない。メタデータを先に
   * UPLOADING で確定し、原本を置いてから STORED にする。
   * 途中で失敗した場合は UPLOADING のまま残り、同じ冪等性キーの再送で
   * 続きから進める。孤立した原本は回収処理が片付ける。
   */
  async register(
    user: AuthenticatedUser,
    caseId: string,
    input: RegisterDocumentInput,
    meta: CommandMeta,
  ): Promise<DocumentView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    if (!meta.idempotency) {
      throw errors.preconditionRequired({
        message: 'この操作には Idempotency-Key ヘッダーが必要です。',
        details: { header: 'Idempotency-Key' },
      })
    }

    // 申告ではなく実体で形式を判定する。
    const contentType = assertSupportedDocument(input.declaredContentType, input.content)
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    const documentId = documentIdFrom(caseId, `${user.userId.length}:${user.userId}/${meta.idempotency.key}`)
    const objectKey = `${objectKeyFor(user.tenantId, caseId, documentId)}/${randomUUID()}`
    const location = documentLocation(caseId, documentId)

    const alreadyStored = await this.uow.run(
      // 冪等性記録は使わない。原本を置く前の状態を結果として固定しないため。
      access.toWorkContext(meta.requestId, null),
      async (tx) => {
        const existing = await tx.get<DocumentEntity>(location)
        if (existing) {
          if (existing.sha256 !== sha256 || existing.fileName !== input.fileName ||
              existing.kind !== input.kind || existing.sizeBytes !== input.content.byteLength ||
              existing.contentType !== contentType) {
            throw errors.idempotencyKeyReused({
              message: '同じキーで異なるファイルが送信されました。',
            })
          }
          // 保存済みなら何もしない。再送で原本が二重に増えない。
          if (existing.storageState === 'STORED' || existing.inspection.status === 'REJECTED') return true
          // 各試行は別の原本キーを所有する。遅い旧試行は新試行を確定・削除できない。
          tx.update<DocumentEntity>(location, existing.version, { objectKey, storageState: 'UPLOADING' })
          return false
        }
        tx.create<DocumentEntity>(location, {
          id: documentId,
          fileName: input.fileName,
          contentType,
          sizeBytes: input.content.byteLength,
          sha256,
          objectKey,
          storageState: 'UPLOADING',
          kind: input.kind,
          // 利用者が登録した種別。AI 由来と区別する。
          kindSource: 'MANUAL',
          inspection: {
            status: 'PENDING',
            findings: [],
            inspectorId: null,
            inspectorVersion: null,
            maskedObjectKey: null,
          },
          analysisState: 'NOT_REQUESTED',
          agentRunId: null,
          archived: false,
          archivedAt: null,
        })
        return false
      },
    )

    if (!alreadyStored) {
      // Transaction の外で行う。Firestore は競合時に Transaction を再実行する。
      await this.storage.put(objectKey, input.content, contentType)
      const inspection = await this.inspect(user.tenantId, caseId, documentId, objectKey, contentType, input.content.byteLength)

      if (inspection.status === 'REJECTED') {
        // 拒否された原本は保持しない。記録だけを残す。
        await this.storage.delete(objectKey)
      }

      const finalized = await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
        const current = await tx.require<DocumentEntity>(location)
        if (current.storageState !== 'UPLOADING' || current.objectKey !== objectKey) return false
        tx.update<DocumentEntity>(location, current.version, {
          storageState: inspection.status === 'REJECTED' ? 'FAILED' : 'STORED',
          inspection,
        })
        tx.audit({
          caseId,
          type: 'document.registered',
          target: { collection: collections.documents.name, id: documentId, version: current.version + 1 },
          detail: { fileName: input.fileName, contentType, inspectionStatus: inspection.status },
        })
        // 解析の受付は行わない。AI 接続と検査合格は別の条件（ADR 0002）。
        tx.outbox({
          type: 'document.registered',
          caseId,
          payload: { caseId, documentId, inspectionStatus: inspection.status },
        })
        return true
      })
      if (!finalized) {
        await this.storage.delete(objectKey)
        throw errors.conflict({ message: '登録の試行が更新または回収されました。同じ要求を再送してください。' })
      }
    }

    return this.toView(user, await this.requireDocument(user.tenantId, caseId, documentId))
  }

  /** 検査器が無ければ PENDING のままにする。合格に倒さない。 */
  private async inspect(
    tenantId: string,
    caseId: string,
    documentId: string,
    objectKey: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<DocumentEntity['inspection']> {
    if (!this.inspector) {
      return { status: 'PENDING', findings: [], inspectorId: null, inspectorVersion: null, maskedObjectKey: null }
    }
    try {
      const result = await this.inspector.inspect({
        tenantId,
        caseId,
        documentId,
        quarantineObjectKey: objectKey,
        contentType,
        sizeBytes,
      })
      return {
        status: result.status,
        findings: result.findings,
        inspectorId: result.inspectorId,
        inspectorVersion: result.inspectorVersion,
        maskedObjectKey: result.maskedObjectKey,
      }
    } catch {
      // 検査そのものの失敗は、合格でも拒否でもない。
      return {
        status: 'FAILED',
        findings: [],
        inspectorId: this.inspector.id,
        inspectorVersion: this.inspector.version,
        maskedObjectKey: null,
      }
    }
  }

  async list(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<DocumentView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')

    const listOptions: ListOptions = {
      limit: options.limit,
      cursor: options.cursor,
      orderBy: { field: 'updatedAt', direction: 'desc' },
      // 除外した書類を通常の一覧に出さない。完全消去とは別の扱い。
      ...(options.includeArchived ? {} : { where: [{ field: 'archived', op: '==', value: false }] }),
    }
    const page = await this.read.list<DocumentEntity>(user.tenantId, collections.documents, caseId, listOptions)
    const items = await Promise.all(page.items.map((entity) => this.toView(user, entity)))
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  async get(user: AuthenticatedUser, caseId: string, documentId: string): Promise<DocumentView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    return this.toView(user, await this.requireDocument(user.tenantId, caseId, documentId))
  }

  /**
   * 原本の取得。
   *
   * 取得のたびに Case の権限を検証する。Web へ Storage の資格情報を
   * 渡さないため、署名 URL ではなく Backend が中継する。
   */
  async content(
    user: AuthenticatedUser,
    caseId: string,
    documentId: string,
  ): Promise<{ content: Uint8Array; contentType: string; fileName: string }> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const entity = await this.requireDocument(user.tenantId, caseId, documentId)

    if (entity.storageState !== 'STORED') {
      throw errors.preconditionFailed({
        message: 'この書類の原本は利用できません。',
        details: { storageState: entity.storageState, inspectionStatus: entity.inspection.status },
      })
    }

    const object = await this.storage.get(entity.objectKey)
    if (!object) {
      // メタデータはあるのに原本が無い。成功として空を返さない。
      throw errors.internal({
        message: '原本を取得できませんでした。',
        internal: { reason: 'object missing for stored document', documentId },
      })
    }
    if (object.contentType !== entity.contentType || object.content.byteLength !== entity.sizeBytes ||
        createHash('sha256').update(object.content).digest('hex') !== entity.sha256) {
      throw errors.internal({ message: '原本の整合性を確認できませんでした。' })
    }
    assertSupportedDocument(object.contentType, object.content)
    return { content: object.content, contentType: entity.contentType, fileName: entity.fileName }
  }

  /**
   * 通常の一覧からの除外。
   *
   * 個人データの完全消去ではない。監査や根拠からの参照を壊さないよう、
   * 文書は残したまま表示の対象から外す。
   */
  async archive(
    user: AuthenticatedUser,
    caseId: string,
    documentId: string,
    expectedVersion: number,
    meta: CommandMeta,
  ): Promise<DocumentView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const location = documentLocation(caseId, documentId)

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<DocumentEntity>(location)
      if (current.archived) return
      tx.update<DocumentEntity>(location, expectedVersion, {
        archived: true,
        archivedAt: new Date().toISOString(),
      })
      tx.audit({
        caseId,
        type: 'document.archived',
        target: { collection: collections.documents.name, id: documentId, version: expectedVersion + 1 },
        detail: { fileName: current.fileName },
      })
    })

    return this.toView(user, await this.requireDocument(user.tenantId, caseId, documentId))
  }

  /**
   * 途中で止まった登録の回収。
   *
   * 原本だけが残る、あるいはメタデータだけが残る状態を放置しない。
   * 定期実行の仕組みは #10 が用意する。
   */
  async reclaimStaleUploads(
    user: AuthenticatedUser,
    caseId: string,
    olderThanMs: number,
  ): Promise<{ reclaimed: string[] }> {
    const access = await this.access.authorizeCase(user, caseId, 'case.administer')
    const threshold = Date.now() - olderThanMs
    const reclaimed: string[] = []

    const page = await this.read.list<DocumentEntity>(user.tenantId, collections.documents, caseId, {
      limit: 100,
      where: [{ field: 'storageState', op: '==', value: 'UPLOADING' }],
      orderBy: { field: 'updatedAt', direction: 'asc' },
    })

    for (const entity of page.items) {
      if (Date.parse(entity.updatedAt) > threshold) continue
      const claimed = await this.uow.run(access.toWorkContext(null, null), async (tx) => {
        const current = await tx.require<DocumentEntity>(documentLocation(caseId, entity.id))
        if (current.storageState !== 'UPLOADING' || current.version !== entity.version ||
            current.objectKey !== entity.objectKey || Date.parse(current.updatedAt) > threshold) return false
        tx.update<DocumentEntity>(documentLocation(caseId, entity.id), current.version, {
          storageState: 'FAILED',
        })
        tx.audit({
          caseId,
          type: 'document.upload_reclaimed',
          target: { collection: collections.documents.name, id: entity.id, version: current.version + 1 },
          detail: { reason: 'upload did not complete' },
        })
        return true
      })
      if (claimed) {
        await this.storage.delete(entity.objectKey)
        reclaimed.push(entity.id)
      }
    }
    return { reclaimed }
  }

  private async requireDocument(
    tenantId: string,
    caseId: string,
    documentId: string,
  ): Promise<DocumentEntity> {
    const entity = await this.read.get<DocumentEntity>(tenantId, documentLocation(caseId, documentId))
    // 別 Case の documentId を指定しても、パスが違うため見つからない。
    if (!entity) throw errors.notFound()
    return entity
  }
}

export type { CaseAccess }
