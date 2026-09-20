/**
 * 監査イベント（仕様書 15.4）。
 *
 * 通常操作では更新も削除もしない追記のみの記録。
 * ただし Firestore だけで無期限保存や完全な改ざん防止を保証したとは扱わない。
 * 保持期間と保護の運用設計は別途必要。
 */
export interface AuditEvent {
  id: string
  tenantId: string
  caseId: string | null
  /** 何が起きたか（例: `case.created`, `task.completed`） */
  type: string
  /** 対象 Entity。削除済みでも追跡できるよう、参照ではなく値で持つ。 */
  target: {
    collection: string
    id: string
    /** 変更後の版。読み取り操作では null。 */
    version: number | null
  }
  /** 誰が行ったか。認証済み actor のみ。自己申告値は入れない。 */
  actor: {
    type: 'USER' | 'SYSTEM' | 'AI'
    userId: string | null
    /** AI 由来の場合の実行 ID。ユーザー入力から偽装できない。 */
    agentRunId: string | null
  }
  /** 要求の追跡 ID。応答の meta.requestId と対応する。 */
  requestId: string | null
  /** 応答に出してよい範囲の差分・理由。原本本文や資格情報は入れない。 */
  detail: Record<string, unknown>
  occurredAt: string
}

export type NewAuditEvent = Omit<AuditEvent, 'id' | 'occurredAt'>
