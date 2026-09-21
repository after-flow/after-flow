/**
 * Rule Engine の代役（モック）。
 *
 * 期限の算定・状態遷移の可否は本来すべて Backend の Rule Engine が行う。
 * ここでは「同じ形の応答を返す」ことだけを目的にした簡易な計算を置く。
 * 本番コードからは参照しない。
 */
import type {
  DeadlineResource,
  FlowStageId,
  FlowStageResource,
  TaskBlockedReasonResource,
  TaskCommandResource,
  TaskResource,
  TaskStatusResource,
} from '@aftercare/public-contracts'

const DAY = 86_400_000

export function todayISO(): string {
  return toISO(new Date())
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function shift(base: string, days: number): string {
  return toISO(new Date(new Date(`${base}T00:00:00`).getTime() + days * DAY))
}

function daysFromToday(iso: string): number {
  const today = new Date(`${todayISO()}T00:00:00`).getTime()
  const due = new Date(`${iso}T00:00:00`).getTime()
  return Math.round((due - today) / DAY)
}

/** 期限が算定できている場合の DeadlineResource を組み立てる。 */
export function makeDeadline(args: {
  id: string
  taskId?: string | null
  label: string
  startDate: string
  days: number
  basisLabel: string
  ruleId: string
  critical?: boolean
  extendable?: boolean
}): DeadlineResource {
  const dueDate = shift(args.startDate, args.days)
  const remaining = daysFromToday(dueDate)
  const severity = remaining < 0 ? 'OVERDUE' : remaining === 0 ? 'URGENT' : remaining <= 3 ? 'SOON' : 'NORMAL'
  return {
    id: args.id,
    taskId: args.taskId ?? null,
    label: args.label,
    basisLabel: args.basisLabel,
    startDate: args.startDate,
    dueDate,
    daysRemaining: remaining,
    severity,
    confirmation: 'CONFIRMED',
    unresolvedReason: null,
    jurisdiction: '日本',
    timezone: 'Asia/Tokyo',
    ruleId: args.ruleId,
    ruleVersion: '1',
    sourceUrl: null,
    sourceCheckedAt: null,
    extendable: args.extendable ?? false,
    critical: args.critical ?? false,
  }
}

/** 起算日が無い・業務レビュー未了など、期限を算定できない場合の DeadlineResource。 */
export function unresolvedDeadline(args: {
  id: string
  taskId?: string | null
  label: string
  basisLabel: string
  ruleId: string
  reason: 'MISSING_BASIS_DATE' | 'RULE_UNCONFIRMED'
}): DeadlineResource {
  return {
    id: args.id,
    taskId: args.taskId ?? null,
    label: args.label,
    basisLabel: args.basisLabel,
    startDate: null,
    dueDate: null,
    daysRemaining: null,
    severity: null,
    confirmation: 'UNCONFIRMED',
    unresolvedReason: args.reason,
    jurisdiction: '日本',
    timezone: 'Asia/Tokyo',
    ruleId: args.ruleId,
    ruleVersion: '1',
    sourceUrl: null,
    sourceCheckedAt: null,
    extendable: null,
    critical: false,
  }
}

export const FLOW_STAGE_LABELS: { id: FlowStageId; label: string }[] = [
  { id: 'immediate', label: '死亡直後の対応' },
  { id: 'funeral', label: '葬儀・火葬（死亡届7日以内）' },
  { id: 'government', label: '役所・公的手続（目安14日以内）' },
  { id: 'contracts', label: '契約・生活の整理' },
  { id: 'investigation', label: '相続の調査' },
  { id: 'decision', label: '相続方法の判断（3か月以内）' },
  { id: 'division', label: '遺産分割' },
  { id: 'transfer', label: '名義変更・受け取り' },
  { id: 'tax', label: '税務（準確定申告4か月・相続税10か月）' },
  { id: 'closing', label: '最終確認・ケースクローズ' },
]

export function computeFlowStages(tasks: TaskResource[]): FlowStageResource[] {
  return FLOW_STAGE_LABELS.map(({ id, label }) => {
    const inStage = tasks.filter((t) => t.stage === id)
    const done = inStage.filter((t) => t.status === 'COMPLETED').length
    return {
      id,
      label,
      totalTasks: inStage.length,
      completedTasks: done,
      state:
        inStage.length === 0
          ? 'NO_TASKS'
          : done === inStage.length
            ? 'COMPLETED'
            : done > 0 || inStage.some((t) => t.status !== 'NOT_STARTED')
              ? 'IN_PROGRESS'
              : 'NOT_STARTED',
    }
  })
}

/**
 * `allowedActions` / `blockedActions` を、いまの状態と付帯条件（財産処分・記録の要否）から組み立てる。
 * `escalate` は専門家引継ぎの提案経由でのみ生まれるため、ここでは出さない。
 */
export function taskActions(
  status: TaskStatusResource,
  opts: { assetDisposal: boolean; decided: boolean; evidenceRequired: boolean; hasEvidence: boolean },
): { allowed: TaskCommandResource[]; blocked: { action: TaskCommandResource; reason: TaskBlockedReasonResource }[] } {
  const FORWARD: Record<TaskStatusResource, TaskCommandResource[]> = {
    NOT_STARTED: ['start', 'requestDocuments', 'markReady'],
    COLLECTING_INFORMATION: ['requestDocuments', 'markReady'],
    WAITING_DOCUMENTS: ['markReady'],
    READY: ['reportSubmission'],
    SUBMITTED: ['awaitExternal'],
    WAITING_EXTERNAL: [],
    ACTION_REQUIRED: ['markReady'],
    COMPLETED: [],
    ESCALATED: [],
  }
  const CAN_COMPLETE: TaskStatusResource[] = ['READY', 'SUBMITTED', 'WAITING_EXTERNAL', 'ACTION_REQUIRED', 'NOT_STARTED', 'COLLECTING_INFORMATION']
  const CAN_FLAG: TaskStatusResource[] = ['NOT_STARTED', 'COLLECTING_INFORMATION', 'WAITING_DOCUMENTS', 'READY', 'SUBMITTED', 'WAITING_EXTERNAL']

  const allowed: TaskCommandResource[] = [...FORWARD[status]]
  const blocked: { action: TaskCommandResource; reason: TaskBlockedReasonResource }[] = []

  if (status === 'COMPLETED') {
    allowed.push('reopen')
  } else if (CAN_COMPLETE.includes(status)) {
    if (opts.assetDisposal && !opts.decided) {
      blocked.push({ action: 'complete', reason: 'INHERITANCE_DECISION_REQUIRED' })
    } else if (opts.evidenceRequired && !opts.hasEvidence) {
      blocked.push({ action: 'complete', reason: 'EVIDENCE_REQUIRED' })
    } else {
      allowed.push('complete')
    }
  } else {
    blocked.push({ action: 'complete', reason: 'INVALID_TRANSITION' })
  }

  if (CAN_FLAG.includes(status)) allowed.push('flagActionRequired')

  return { allowed, blocked }
}
