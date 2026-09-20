import { createHash, randomUUID } from 'node:crypto'
import type { DocumentReference, Firestore, Transaction } from '@google-cloud/firestore'
import { FieldValue } from '@google-cloud/firestore'
import type { DocLocation, Tx, UnitOfWork, WorkContext } from '../../application/ports/persistence.js'
import { SERVER_TIME } from '../../application/ports/persistence.js'
import type { NewAuditEvent } from '../../domain/shared/audit.js'
import { collections, INFRASTRUCTURE_COLLECTIONS } from '../../domain/shared/collections.js'
import type { EntityBase, EntityPatch } from '../../domain/shared/entity.js'
import { CURRENT_SCHEMA_VERSION } from '../../domain/shared/entity.js'
import type { NewOutboxEvent } from '../../domain/shared/outbox.js'
import { AppError, errors } from '../../shared/app-error.js'
import { fromFirestoreDocument } from './client.js'
import { assertPathMatchesDocument, assertValidId, documentPath, infrastructurePath } from './paths.js'

/** Firestore の ALREADY_EXISTS。文字列比較ではなく gRPC のコードで判定する。 */
const ALREADY_EXISTS = 6

/** 冪等性の記録に保存する結果の上限。Firestore の 1 文書 1 MiB に対する余裕を取る。 */
const MAX_IDEMPOTENT_RESULT_BYTES = 128 * 1024

/** Entity の共通項目。patch で直接触らせない。 */
const MANAGED_FIELDS = ['id', 'tenantId', 'caseId', 'version', 'schemaVersion', 'createdAt', 'updatedAt']

type PendingWrite =
  | { kind: 'create'; ref: DocumentReference; data: Record<string, unknown> }
  | { kind: 'update'; ref: DocumentReference; data: Record<string, unknown> }
  | { kind: 'delete'; ref: DocumentReference }

type PendingAudit = Omit<NewAuditEvent, 'tenantId' | 'actor' | 'requestId'>

/**
 * SERVER_TIME の印をサーバー時刻へ置き換える。
 *
 * 配列の中は置き換えない。保存側が配列内の sentinel を受け付けないため、
 * 黙って壊れた値を書くより、印のまま保存されて試験で気付くほうがよい。
 */
function withServerTime(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      value === SERVER_TIME ? FieldValue.serverTimestamp() : value,
    ]),
  )
}

/**
 * Transaction の中で使う操作の実装。
 *
 * 書き込みは即時に発行せず、fn が終わってから commit 時にまとめて適用する。
 * Firestore は「すべての読み取りをすべての書き込みより前に」要求するため、
 * 呼び出し側に読み書きの順序を意識させない。
 */
class FirestoreTx implements Tx {
  readonly writes: PendingWrite[] = []
  readonly auditEvents: PendingAudit[] = []
  readonly outboxEvents: NewOutboxEvent[] = []
  /** この Transaction 内で読み取った版。更新はここを根拠に検査する。 */
  private readonly readVersions = new Map<string, number>()

  constructor(
    private readonly firestore: Firestore,
    private readonly transaction: Transaction,
    private readonly context: WorkContext,
  ) {}

  private ref(location: DocLocation): DocumentReference {
    return this.firestore.doc(documentPath(this.context.tenantId, location))
  }

  async get<T extends EntityBase>(location: DocLocation): Promise<T | null> {
    const ref = this.ref(location)
    const snapshot = await this.transaction.get(ref)
    if (!snapshot.exists) {
      this.readVersions.delete(ref.path)
      return null
    }
    const data = fromFirestoreDocument<T>(snapshot.data() as Record<string, unknown>)
    // 別 Case の ID へ差し替えた要求を、読み出しのたびに突き合わせて検出する。
    assertPathMatchesDocument(location, this.context.tenantId, data)
    this.readVersions.set(ref.path, data.version)
    return data
  }

  async require<T extends EntityBase>(location: DocLocation): Promise<T> {
    const found = await this.get<T>(location)
    if (!found) throw errors.notFound()
    return found
  }

  create<T extends EntityBase>(
    location: DocLocation,
    data: Omit<T, keyof EntityBase> & { id: string },
  ): void {
    if (data.id !== location.id) {
      throw errors.internal({
        internal: { reason: 'create id mismatch', id: data.id, location: location.id },
      })
    }
    this.writes.push({
      kind: 'create',
      ref: this.ref(location),
      data: {
        ...withServerTime(data as Record<string, unknown>),
        tenantId: this.context.tenantId,
        caseId: location.caseId,
        version: 1,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    })
  }

  update<T extends EntityBase>(
    location: DocLocation,
    expectedVersion: number,
    patch: EntityPatch<T>,
  ): void {
    const ref = this.ref(location)
    const current = this.versionFromThisTransaction(ref, 'update')
    if (current !== expectedVersion) {
      throw errors.conflict({ details: { expectedVersion, currentVersion: current } })
    }
    for (const key of Object.keys(patch)) {
      if (MANAGED_FIELDS.includes(key)) {
        throw errors.internal({ internal: { reason: 'patch touches a managed field', field: key } })
      }
    }
    this.writes.push({
      kind: 'update',
      ref,
      data: {
        ...withServerTime(patch as Record<string, unknown>),
        version: current + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
    })
  }

  delete(location: DocLocation, expectedVersion: number): void {
    const ref = this.ref(location)
    const current = this.versionFromThisTransaction(ref, 'delete')
    if (current !== expectedVersion) {
      throw errors.conflict({ details: { expectedVersion, currentVersion: current } })
    }
    this.writes.push({ kind: 'delete', ref })
  }

  /**
   * 読まずに更新すると版の検査が形だけになる。
   * Transaction 内で読んだ版だけを根拠にすることで、commit 時の競合検出と
   * 版の比較が同じ読み取りに基づくことを保証する。
   */
  private versionFromThisTransaction(ref: DocumentReference, operation: string): number {
    const current = this.readVersions.get(ref.path)
    if (current === undefined) {
      throw errors.internal({
        internal: { reason: `${operation} without reading the document first`, path: ref.path },
      })
    }
    return current
  }

  audit(event: PendingAudit): void {
    this.auditEvents.push(event)
  }

  outbox(event: NewOutboxEvent): void {
    this.outboxEvents.push(event)
  }
}

/**
 * 冪等性記録の文書 ID。
 *
 * tenant と actor でスコープを分け、他人のキーと衝突させない。
 * 長さを前置して、区切り文字を含むキーで別の組み合わせと同じ値にならないようにする。
 */
function idempotencyDocId(tenantId: string, key: string, actorId: string | null): string {
  const actor = actorId ?? ''
  const material = `${tenantId.length}:${tenantId}/${actor.length}:${actor}/${key.length}:${key}`
  return createHash('sha256').update(material).digest('hex')
}

export class FirestoreUnitOfWork implements UnitOfWork {
  constructor(private readonly firestore: Firestore) {}

  async run<T>(context: WorkContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertValidId(context.tenantId, 'tenantId')

    try {
      return await this.firestore.runTransaction(async (transaction) => {
        const idempotency = context.idempotency ?? null
        let idempotencyRef: DocumentReference | null = null

        if (idempotency) {
          idempotencyRef = this.firestore.doc(
            infrastructurePath(
              context.tenantId,
              INFRASTRUCTURE_COLLECTIONS.idempotency,
              idempotencyDocId(context.tenantId, idempotency.key, context.actor.userId),
            ),
          )
          // 不在でも Transaction の読み取りとして登録される。
          // 同じキーの並行要求は、片方が commit した時点でもう片方が再実行される。
          const snapshot = await transaction.get(idempotencyRef)
          if (snapshot.exists) {
            const stored = snapshot.data() as { fingerprint?: string; result?: string }
            if (stored.fingerprint !== idempotency.fingerprint) {
              // 同じキーで別の内容。前回の結果を返すと違う操作の結果を返すことになる。
              throw errors.idempotencyKeyReused()
            }
            return JSON.parse(stored.result ?? 'null') as T
          }
        }

        const tx = new FirestoreTx(this.firestore, transaction, context)
        const result = await fn(tx)

        // ここから先が書き込み。読み取りはすべて上で終わっている。
        this.applyWrites(transaction, tx.writes)
        this.applyAudit(transaction, context, tx.auditEvents)
        this.applyOutbox(transaction, context, tx.outboxEvents)

        if (idempotencyRef && idempotency) {
          const serialized = JSON.stringify(result ?? null)
          if (serialized.length > MAX_IDEMPOTENT_RESULT_BYTES) {
            throw errors.internal({
              internal: { reason: 'idempotent result too large', bytes: serialized.length },
            })
          }
          transaction.create(idempotencyRef, {
            // キーそのものは保存しない。照合には hash 済みの文書 ID を使う。
            fingerprint: idempotency.fingerprint,
            result: serialized,
            actorUserId: context.actor.userId,
            createdAt: FieldValue.serverTimestamp(),
          })
        }

        return result
      })
    } catch (cause) {
      throw translateFirestoreError(cause)
    }
  }

  private applyWrites(transaction: Transaction, writes: PendingWrite[]): void {
    for (const write of writes) {
      if (write.kind === 'create') transaction.create(write.ref, write.data)
      else if (write.kind === 'update') transaction.update(write.ref, write.data)
      else transaction.delete(write.ref)
    }
  }

  private applyAudit(transaction: Transaction, context: WorkContext, events: PendingAudit[]): void {
    for (const event of events) {
      const id = randomUUID()
      const path =
        event.caseId === null
          ? infrastructurePath(context.tenantId, 'auditEvents', id)
          : documentPath(context.tenantId, {
              collection: collections.auditEvents,
              caseId: event.caseId,
              id,
            })
      transaction.create(this.firestore.doc(path), {
        id,
        tenantId: context.tenantId,
        caseId: event.caseId,
        type: event.type,
        target: event.target,
        // actor と requestId は呼び出し側の申告ではなく context から入れる。
        actor: context.actor,
        requestId: context.requestId,
        detail: event.detail,
        occurredAt: FieldValue.serverTimestamp(),
      })
    }
  }

  private applyOutbox(transaction: Transaction, context: WorkContext, events: NewOutboxEvent[]): void {
    for (const event of events) {
      const id = event.id ?? randomUUID()
      assertValidId(id, 'outboxEventId')
      transaction.create(
        this.firestore.doc(
          infrastructurePath(context.tenantId, INFRASTRUCTURE_COLLECTIONS.outbox, id),
        ),
        {
          id,
          tenantId: context.tenantId,
          caseId: event.caseId ?? null,
          type: event.type,
          payload: event.payload,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: FieldValue.serverTimestamp(),
          lastError: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      )
    }
  }
}

/**
 * Firestore の失敗を公開契約のエラーへ写す。
 *
 * ALREADY_EXISTS をそのまま 500 で返すと、再送による重複作成が
 * 「サーバー障害」に見えてクライアントが再試行を続ける。
 */
export function translateFirestoreError(cause: unknown): unknown {
  if (cause instanceof AppError) return cause
  const code = (cause as { code?: unknown } | null)?.code
  if (code === ALREADY_EXISTS) {
    return errors.conflict({ message: '同じ識別子の対象が既に存在します。', cause })
  }
  return cause
}
