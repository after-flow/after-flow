import type { TaskBlockedReasonResource, TaskCommandResource, TaskResource } from '@aftercare/public-contracts'

/** `allowedActions` から出すボタンの文言。`escalate` は出さない（専門家引継ぎは提案経由）。 */
export const TASK_COMMAND_WORD: Record<TaskCommandResource, string> = {
  start: '取りかかる',
  requestDocuments: '書類を待つ',
  markReady: '準備ができた',
  reportSubmission: '提出した',
  awaitExternal: '先方の処理を待つ',
  complete: '済んだので記録する',
  reopen: '完了を取り消す',
  flagActionRequired: '対応が必要になった',
  escalate: '専門家に引き継ぐ',
}

export const TASK_BLOCKED_REASON_WORD: Record<TaskBlockedReasonResource, string> = {
  INVALID_TRANSITION: 'いまの状態からはできません',
  EVIDENCE_REQUIRED: '完了には記録が必要です',
  INHERITANCE_DECISION_REQUIRED: '相続の方法が決まるまで進められません',
  INSUFFICIENT_ROLE: 'この操作を行う権限がありません',
  DEPENDENCY_NOT_COMPLETED: '先に済ませる手続きがあります',
}

/** `escalate` を除いた、画面に出してよい操作。 */
export function visibleActions(task: TaskResource): TaskCommandResource[] {
  return task.allowedActions.filter((a) => a !== 'escalate')
}

export interface TaskDependencyView {
  taskId: string
  label: string
  satisfied: boolean
}

/** 依存する手続きの表示行。相手のタイトルが引けない場合は汎用文言にする。 */
export function taskDependencies(task: TaskResource, all: TaskResource[]): TaskDependencyView[] {
  return task.dependencyTaskIds.map((id) => {
    const dep = all.find((t) => t.id === id)
    return { taskId: id, label: dep?.title ?? '先に済ませる手続き', satisfied: dep?.status === 'COMPLETED' }
  })
}
