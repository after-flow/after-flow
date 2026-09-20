/**
 * 業務 Firestore のコレクション定義（仕様書 15.1）。
 *
 * 保存パスを利用者入力から組み立てられないよう、扱ってよいコレクションを
 * ここに列挙する。未登録の名前は Repository が拒否する。
 */
export type CollectionScope = 'tenant' | 'case'

export interface CollectionDescriptor {
  readonly name: string
  readonly scope: CollectionScope
}

function tenantCollection(name: string): CollectionDescriptor {
  return { name, scope: 'tenant' }
}

function caseCollection(name: string): CollectionDescriptor {
  return { name, scope: 'case' }
}

/**
 * 実装済みの責務に対応するものだけを登録する。
 * 仕様書にある将来のコレクションは、その機能を実装する Issue で追加する。
 */
export const collections = {
  /** tenant のメンバー。Case membership とは別。 */
  members: tenantCollection('members'),
  cases: tenantCollection('cases'),
  /**
   * Case ごとの role / scope。
   *
   * tenant 直下の members と別の名前にしてある。案件横断の membership 検索は
   * collection group query を使うため、同名だと tenant メンバーまで拾ってしまう。
   */
  caseMembers: caseCollection('caseMembers'),
  auditEvents: caseCollection('auditEvents'),
  /** 利用者ごとの同意状態。Case には属さない。 */
  consents: tenantCollection('consents'),
  documents: caseCollection('documents'),
  tasks: caseCollection('tasks'),
  deadlines: caseCollection('deadlines'),
  evidence: caseCollection('evidence'),
  agentRuns: caseCollection('agentRuns'),
  /** Case ごとの書き込み権。固定 ID の 1 文書だけを使う。 */
  caseLeases: caseCollection('coordination'),
  proposals: caseCollection('proposals'),
  approvals: caseCollection('approvals'),
  decisions: caseCollection('decisions'),
  messages: caseCollection('messages'),
  guidance: caseCollection('guidance'),
  persons: caseCollection('persons'),
  relationships: caseCollection('relationships'),
  assets: caseCollection('assets'),
  liabilities: caseCollection('liabilities'),
  contracts: caseCollection('contracts'),
  benefits: caseCollection('benefits'),
  insights: caseCollection('insights'),
  insightViews: caseCollection('insightViews'),
  insightResults: caseCollection('insightResults'),
} as const

export type CollectionKey = keyof typeof collections

const byName = new Map<string, CollectionDescriptor>()
for (const descriptor of Object.values(collections)) {
  byName.set(`${descriptor.scope}:${descriptor.name}`, descriptor)
}

export function isRegisteredCollection(descriptor: CollectionDescriptor): boolean {
  return byName.get(`${descriptor.scope}:${descriptor.name}`) === descriptor
}

/** tenant 直下の固定コレクション。Entity ではなく基盤が管理する。 */
export const INFRASTRUCTURE_COLLECTIONS = {
  outbox: 'outbox',
  inbox: 'inbox',
  idempotency: 'idempotency',
} as const
