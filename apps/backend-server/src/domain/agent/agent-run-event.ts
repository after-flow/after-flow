import type { AgentRunStatus } from './agent-run.js'
import type { EntityBase } from '../shared/entity.js'

/**
 * 公開可能なAgentRun進捗イベント（Issue #125）。
 *
 * 「受付・処理中・待機・再開・完了」の履歴を時系列で示すための読み取り専用の記録。
 * 対象Runの状態遷移と同じ業務transactionでのみ追記し、後から書き換えない。
 *
 * prompt、非公開の思考過程、資格情報、原本文はここへ絶対に書かない。
 * `detail` へ入れてよいのは、列挙値・ID・件数などの安全な範囲だけ。
 *
 * 「処理中」stageは現時点でAIが内部APIへ送るPROGRESSイベント（`event()`）
 * だけが表す。BackendはQUEUED→RUNNINGの遷移自体をイベントとして記録しない
 * （chat_reply/task_guidanceのようにAIがPROGRESSを送らない操作では、公開
 * 履歴はACCEPTEDの次にRESULTが並ぶ）。
 */
export type AgentRunEventKind =
  | 'ACCEPTED'
  | 'PROGRESS'
  | 'WAITING'
  | 'RESUMED'
  | 'RESULT'
  | 'CANCELLED'
  | 'RETRIED'

export interface AgentRunEventEntity extends EntityBase {
  runId: string
  /**
   * 送信側が持つ識別子。
   *
   * AI由来（progress/wait/result）はAIが発行したeventId/resultIdをそのまま使う。
   * 利用者・Backend起点（accept/cancel/retry/resume）はBackendが発行する。
   * 同じrunId内で同じeventIdの再送は新しい行を作らない（`recordAgentRunEvent`が保証）。
   */
  eventId: string
  kind: AgentRunEventKind
  /** このイベントが確定した時点のRun状態。 */
  status: AgentRunStatus
  /** このイベントが確定した時点のattempt。 */
  attempt: number
  /**
   * Run内での発生順。
   *
   * 同じRunの書き込みは常にRun Entityのversionを1つ進める処理と同じ
   * transactionで行うため、直後のversion（更新後の版）をそのまま採番に使う。
   * Run Entityはこのイベント種別以外の理由でも版が進む（context取得や
   * heartbeatなど）ため連番ではないが、別カウンタを持たずに厳密な昇順
   * （同じRunの2つの行が同じ値を取らない）を保証できる。
   */
  sequence: number
  /** 利用者へ見せてよい範囲の付随情報のみ。 */
  detail: Record<string, unknown>
}
