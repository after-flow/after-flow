import { readFileSync } from 'node:fs'
import { PLACEHOLDER_CATALOG } from '../../domain/consent/catalog.js'
import type { ConsentCatalog } from '../../domain/consent/consent.js'

/**
 * 同意文書のカタログを設定から読み込む。
 *
 * 文面・提供先・目的・保持条件は業務側が承認したものを使う。
 * 実装側で架空の提供先や国名を作らない。設定が無い場合は、仮の文面だと
 * 分かる形の開発用カタログを使い、本番ではそれを拒否する。
 */
export function readConsentCatalog(env: NodeJS.ProcessEnv = process.env): ConsentCatalog {
  const path = env.CONSENT_CATALOG_PATH

  if (!path) {
    if (env.NODE_ENV === 'production') {
      throw new Error('CONSENT_CATALOG_PATH が未設定です。未確定の仮文面のまま本番で同意を取得しない。')
    }
    return PLACEHOLDER_CATALOG
  }

  const catalog = JSON.parse(readFileSync(path, 'utf8')) as ConsentCatalog
  if (catalog.placeholder && env.NODE_ENV === 'production') {
    throw new Error('placeholder: true のカタログは本番で使用できません。')
  }
  assertUsable(catalog)
  return catalog
}

function assertUsable(catalog: ConsentCatalog): void {
  const kinds = new Set(catalog.documents.map((document) => document.kind))
  // 必須同意の定義が欠けていると、未同意の判定が素通りする。
  for (const required of ['TERMS', 'PRIVACY'] as const) {
    if (!kinds.has(required)) {
      throw new Error(`同意カタログに ${required} がありません。`)
    }
  }
  if (kinds.size !== catalog.documents.length) {
    throw new Error('同意カタログに同じ種別が重複しています。')
  }
  for (const document of catalog.documents) {
    if (!document.version || !document.url || document.summary.length === 0) {
      throw new Error(`同意文書 ${document.kind} の定義が不完全です。`)
    }
  }
}
