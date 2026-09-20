import type { CollectionDescriptor } from '../../domain/shared/collections.js'
import { isRegisteredCollection } from '../../domain/shared/collections.js'
import type { DocLocation } from '../../application/ports/persistence.js'
import { errors } from '../../shared/app-error.js'

/**
 * 保存パスの組み立てと検証。
 *
 * 識別子が利用者入力から来る以上、`/` や `..` を含む値でパスを組み立てると
 * 別 tenant・別 Case の文書を指せてしまう。ここを唯一の入口にする。
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function assertValidId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw errors.validationFailed({
      message: '識別子の形式が正しくありません。',
      details: { field: label },
      internal: { label },
    })
  }
}

export function tenantPath(tenantId: string): string {
  assertValidId(tenantId, 'tenantId')
  return `tenants/${tenantId}`
}

export function casePath(tenantId: string, caseId: string): string {
  assertValidId(caseId, 'caseId')
  return `${tenantPath(tenantId)}/cases/${caseId}`
}

export function collectionPath(
  tenantId: string,
  collection: CollectionDescriptor,
  caseId: string | null,
): string {
  if (!isRegisteredCollection(collection)) {
    // 登録外のコレクション名は実装の誤り。利用者入力がここへ届いてはいけない。
    throw errors.internal({ internal: { reason: 'unregistered collection', name: collection.name } })
  }
  if (collection.scope === 'case') {
    if (caseId === null) {
      throw errors.internal({ internal: { reason: 'caseId required', collection: collection.name } })
    }
    return `${casePath(tenantId, caseId)}/${collection.name}`
  }
  if (caseId !== null) {
    throw errors.internal({ internal: { reason: 'caseId not allowed', collection: collection.name } })
  }
  return `${tenantPath(tenantId)}/${collection.name}`
}

export function documentPath(tenantId: string, location: DocLocation): string {
  assertValidId(location.id, 'id')
  return `${collectionPath(tenantId, location.collection, location.caseId)}/${location.id}`
}

export function infrastructurePath(tenantId: string, collection: string, id: string): string {
  assertValidId(id, 'id')
  return `${tenantPath(tenantId)}/${collection}/${id}`
}

/**
 * 文書の中身と保存パスの一致を検証する。
 *
 * ID を文書にも持たせているのは表示の都合ではなく、別 Case の documentId へ
 * 差し替えた要求を検出するため。読み出しのたびに突き合わせる。
 */
export function assertPathMatchesDocument(
  location: DocLocation,
  tenantId: string,
  document: { id?: unknown; tenantId?: unknown; caseId?: unknown },
): void {
  const mismatch =
    document.id !== location.id ||
    document.tenantId !== tenantId ||
    (document.caseId ?? null) !== location.caseId
  if (mismatch) {
    throw errors.internal({
      message: '保存データの整合性を確認できませんでした。',
      internal: {
        reason: 'document does not match its path',
        expected: { id: location.id, tenantId, caseId: location.caseId },
        actual: { id: document.id, tenantId: document.tenantId, caseId: document.caseId ?? null },
      },
    })
  }
}
