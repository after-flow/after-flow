import type { Firestore, Query } from '@google-cloud/firestore'
import { FieldPath } from '@google-cloud/firestore'
import type {
  DocLocation,
  ListOptions,
  Page,
  ReadRepository,
} from '../../application/ports/persistence.js'
import type { CollectionDescriptor } from '../../domain/shared/collections.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { fromFirestoreDocument } from './client.js'
import {
  decodeCursor,
  decodeCursorValue,
  encodeCursor,
  encodeCursorValue,
  queryFingerprint,
} from './cursor.js'
import { assertPathMatchesDocument, assertValidId, collectionPath, documentPath } from './paths.js'

const DEFAULT_ORDER = { field: 'updatedAt', direction: 'desc' } as const

/**
 * Transaction の外で行う読み取り。
 *
 * 一覧はカーソルページングだけを提供する。全件取得の入口を作ると、
 * 集約や画面が 1 ページ目を全件として扱う実装を誘発する。
 */
export class FirestoreReadRepository implements ReadRepository {
  constructor(private readonly firestore: Firestore) {}

  async get<T extends EntityBase>(tenantId: string, location: DocLocation): Promise<T | null> {
    assertValidId(tenantId, 'tenantId')
    const snapshot = await this.firestore.doc(documentPath(tenantId, location)).get()
    if (!snapshot.exists) return null
    const data = fromFirestoreDocument<T>(snapshot.data() as Record<string, unknown>)
    assertPathMatchesDocument(location, tenantId, data)
    return data
  }

  async list<T extends EntityBase>(
    tenantId: string,
    collection: CollectionDescriptor,
    caseId: string | null,
    options: ListOptions,
  ): Promise<Page<T>> {
    assertValidId(tenantId, 'tenantId')
    const order = options.orderBy ?? DEFAULT_ORDER
    const where = options.where ?? []

    const fingerprint = queryFingerprint({
      collection: `${collection.scope}:${collection.name}`,
      caseId,
      order,
      where,
    })

    let query: Query = this.firestore.collection(collectionPath(tenantId, collection, caseId))
    for (const clause of where) {
      query = query.where(clause.field, clause.op, clause.value)
    }
    query = query.orderBy(order.field, order.direction)
    // 並び替えキーが同値の文書で順序が揺れないよう、文書 ID で必ず割る。
    // これが無いとページ境界で欠落や重複が起きる。
    query = query.orderBy(FieldPath.documentId(), order.direction)

    if (options.cursor) {
      const cursor = decodeCursor(options.cursor, fingerprint)
      query = query.startAfter(...cursor.values.map(decodeCursorValue), cursor.id)
    }

    // 1 件多く読んで、続きがあるかを件数ではなく実在で判定する。
    const snapshot = await query.limit(options.limit + 1).get()
    const docs = snapshot.docs.slice(0, options.limit)
    const items = docs.map((doc) => {
      const data = fromFirestoreDocument<T>(doc.data() as Record<string, unknown>)
      assertPathMatchesDocument({ collection, caseId, id: doc.id }, tenantId, data)
      return data
    })

    if (snapshot.docs.length <= options.limit) return { items }

    const last = docs[docs.length - 1]
    if (!last) return { items }
    return {
      items,
      nextCursor: encodeCursor({
        fingerprint,
        values: [encodeCursorValue(last.get(order.field))],
        id: last.id,
      }),
    }
  }
}
