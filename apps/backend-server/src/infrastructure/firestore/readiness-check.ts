import type { Firestore } from '@google-cloud/firestore'
import type { ReadinessCheck } from '../../application/operations/readiness-service.js'

/**
 * 業務Firestoreへの疎通。
 *
 * `listCollections()` はroot直下のcollection ID一覧を返す管理系呼び出しで、
 * 業務Entityを読み書きしない。接続先・資格情報・ネットワークが有効かだけを見る。
 * 結果（collection ID）は使わず捨てる。応答へ含めない。
 */
export function createFirestoreReadinessCheck(firestore: Firestore): ReadinessCheck {
  return {
    name: 'firestore',
    async run() {
      await firestore.listCollections()
      return { ok: true }
    },
  }
}
