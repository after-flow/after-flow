import { textHash } from '../../src/infrastructure/research/official-catalog.js'
import type { SourceCandidate, SourceDocument } from '../../src/orchestration/research/sources.js'

/** 取得済み資料のfixture。本文は1区分として扱い、ハッシュは本番と同じ関数で作る。 */
export function sourceDocument(candidate: SourceCandidate, text: string, extra: Partial<SourceDocument> = {}): SourceDocument {
  return {
    ...candidate, text, location: '第1項', fetchedAt: new Date().toISOString(), updatedAt: null,
    contentHash: textHash(text), sections: [{ id: 's1', heading: null, anchor: null, text }], forms: [],
    ...extra,
  }
}
