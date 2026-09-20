import type { TaskStatus } from './task.js'

/**
 * Task の状態遷移（仕様書 7・16 章）。
 *
 * status を直接 PATCH させず、意味のある操作だけを許す。
 * 任意の値を書き込めると、完了条件の検証が素通りする。
 */
export type TaskCommand =
  | 'start'
  | 'requestDocuments'
  | 'markReady'
  | 'reportSubmission'
  | 'awaitExternal'
  | 'complete'
  | 'reopen'
  | 'flagActionRequired'
  | 'escalate'

const TRANSITIONS: Record<TaskCommand, { from: TaskStatus[]; to: TaskStatus }> = {
  start: { from: ['NOT_STARTED', 'ACTION_REQUIRED'], to: 'COLLECTING_INFORMATION' },
  requestDocuments: { from: ['COLLECTING_INFORMATION'], to: 'WAITING_DOCUMENTS' },
  // 準備完了。外部への提出はまだ行われていない。
  markReady: { from: ['COLLECTING_INFORMATION', 'WAITING_DOCUMENTS'], to: 'READY' },
  // 本人による提出の報告。外部機関の受理確認ではない。
  reportSubmission: { from: ['READY'], to: 'SUBMITTED' },
  awaitExternal: { from: ['SUBMITTED'], to: 'WAITING_EXTERNAL' },
  complete: {
    from: ['NOT_STARTED', 'COLLECTING_INFORMATION', 'READY', 'SUBMITTED', 'WAITING_EXTERNAL', 'ACTION_REQUIRED'],
    to: 'COMPLETED',
  },
  reopen: { from: ['COMPLETED'], to: 'ACTION_REQUIRED' },
  flagActionRequired: {
    from: ['COLLECTING_INFORMATION', 'WAITING_DOCUMENTS', 'READY', 'SUBMITTED', 'WAITING_EXTERNAL'],
    to: 'ACTION_REQUIRED',
  },
  escalate: {
    from: [
      'NOT_STARTED',
      'COLLECTING_INFORMATION',
      'WAITING_DOCUMENTS',
      'READY',
      'SUBMITTED',
      'WAITING_EXTERNAL',
      'ACTION_REQUIRED',
    ],
    to: 'ESCALATED',
  },
}

export const ALL_TASK_COMMANDS = Object.keys(TRANSITIONS) as TaskCommand[]

export function isAllowedTransition(command: TaskCommand, from: TaskStatus): boolean {
  return TRANSITIONS[command].from.includes(from)
}

export function targetStatus(command: TaskCommand): TaskStatus {
  return TRANSITIONS[command].to
}

/** 終了状態。ここからは escalate も含めて戻せない（reopen を除く）。 */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'COMPLETED' || status === 'ESCALATED'
}
