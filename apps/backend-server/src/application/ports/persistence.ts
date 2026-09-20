import type { NewAuditEvent } from '../../domain/shared/audit.js'
import type { CollectionDescriptor } from '../../domain/shared/collections.js'
import type { EntityBase, EntityPatch } from '../../domain/shared/entity.js'
import type { NewOutboxEvent } from '../../domain/shared/outbox.js'

/**
 * 永続化のポート。
 *
 * Application と Domain は Firestore を知らない。実装は
 * `infrastructure/firestore` にだけ置き、テストでも同じポートを使う。
 */

/**
 * サーバー時刻を入れる場所を示す印。
 *
 * Application が時計を持つと、保存された時刻が各プロセスの時計に
 * 依存する。保存側がこの印をサーバー時刻へ置き換える。
 * 配列の要素には使えない（保存側の制約）。時系列の正本は AuditEvent。
 */
export const SERVER_TIME = '__server_time__'

/** 操作した主体。認証済みの情報からのみ組み立てる。 */
export interface ActorRef {
  type: 'USER' | 'SYSTEM' | 'AI'
  userId: string | null
  agentRunId: string | null
}

export interface DocLocation {
  collection: CollectionDescriptor
  /** Case 配下のコレクションでは必須。tenant 直下では null。 */
  caseId: string | null
  id: string
}

export interface IdempotencyRequest {
  key: string
  /**
   * 要求内容の指紋。
   * 同じキーで異なる内容が送られたことを検出するために使う。
   * 内容そのものは保存しない。
   */
  fingerprint: string
}

export interface WorkContext {
  tenantId: string
  actor: ActorRef
  /** 応答の meta.requestId と同じ値。監査から要求を追えるようにする。 */
  requestId: string | null
  /** 指定すると同じキーの再送を重複適用しない。 */
  idempotency?: IdempotencyRequest | null
}

/**
 * Transaction の中で使える操作。
 *
 * 書き込みは即時に実行せず commit 時にまとめて適用する。
 * Firestore が「すべての読み取りをすべての書き込みより前に」要求するため、
 * 呼び出し側が読み書きの順序を気にしなくて済むようにしている。
 */
export interface Tx {
  get<T extends EntityBase>(location: DocLocation): Promise<T | null>
  /** 見つからない場合は NOT_FOUND を投げる。 */
  require<T extends EntityBase>(location: DocLocation): Promise<T>
  /**
   * 新規作成。同じ ID が既に存在する場合は CONFLICT。
   * version は 1、時刻はサーバー時刻で確定する。
   */
  create<T extends EntityBase>(location: DocLocation, data: Omit<T, keyof EntityBase> & { id: string }): void
  /**
   * 更新。expectedVersion が現在の版と異なれば CONFLICT。
   * 版の比較は Transaction の中で行うため、先行更新を上書きしない。
   */
  update<T extends EntityBase>(location: DocLocation, expectedVersion: number, patch: EntityPatch<T>): void
  /** 物理削除。通常の利用停止は各 Entity の状態で表し、これは使わない。 */
  delete(location: DocLocation, expectedVersion: number): void
  /** 監査イベントを同じ Transaction で追記する。 */
  audit(event: Omit<NewAuditEvent, 'tenantId' | 'actor' | 'requestId'>): void
  /** Outbox へ同じ Transaction で積む。配送は #10。 */
  outbox(event: NewOutboxEvent): void
}

export interface UnitOfWork {
  /**
   * Entity 変更・AuditEvent・Outbox・冪等性結果を 1 つの Transaction で確定する。
   *
   * fn の中で外部 HTTP、LLM、Queue 送信、Storage 操作を行わないこと。
   * Firestore は競合時に fn を再実行するため、副作用が複数回起きる。
   */
  run<T>(context: WorkContext, fn: (tx: Tx) => Promise<T>): Promise<T>
}

export interface ListOptions {
  limit: number
  cursor?: string | undefined
  /** 既定は updatedAt の降順。 */
  orderBy?: { field: string; direction: 'asc' | 'desc' }
  where?: { field: string; op: '==' | '<' | '<=' | '>' | '>='; value: unknown }[]
}

export interface ListGroupOptions extends ListOptions {
  /**
   * 並び替えキーが同値のときに順序を決める項目。
   *
   * collection group query では文書 ID が完全パスになり、ページ境界の
   * 比較に使いづらい。問い合わせ条件の中で一意になる項目を指定する。
   */
  tiebreakField: string
}

export interface Page<T> {
  items: T[]
  /** 続きがある場合のみ。件数から全件を推測させない。 */
  nextCursor?: string
}

/**
 * Transaction の外で行う読み取り。
 * 一覧はカーソルページングのみを提供し、全件取得の入口を作らない。
 */
export interface ReadRepository {
  get<T extends EntityBase>(tenantId: string, location: DocLocation): Promise<T | null>
  list<T extends EntityBase>(
    tenantId: string,
    collection: CollectionDescriptor,
    caseId: string | null,
    options: ListOptions,
  ): Promise<Page<T>>
  /**
   * Case を跨いだ横断検索。
   *
   * 「自分がメンバーである Case の一覧」のように、親が特定できない
   * 問い合わせだけに使う。tenant の境界は必ず条件に含める。
   */
  listGroup<T extends EntityBase>(
    tenantId: string,
    collection: CollectionDescriptor,
    options: ListGroupOptions,
  ): Promise<Page<T>>
}
