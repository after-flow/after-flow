import { clarificationHistorySchema } from '@aftercare/internal-contracts'
import type { AgentRunOutcomeResource } from '@aftercare/public-contracts'
import type { CaseMember } from '../../domain/authorization/case-role.js'
import { roleAllows } from '../../domain/authorization/case-role.js'
import type { TenantMember } from '../authorization/case-access.js'
import type { MessageEntity } from '../../domain/message/message.js'
import { randomUUID } from 'node:crypto'
import type { AgentOperation, AgentRunEntity, AgentRunStatus } from '../../domain/agent/agent-run.js'
import { canCancel, canRetry, isRunTerminal, isRunWaiting } from '../../domain/agent/agent-run.js'
import type { CaseEntity } from '../../domain/case/case.js'
import { collections } from '../../domain/shared/collections.js'
import type { GuidanceEntity } from '../../domain/task/guidance.js'
import type { TaskEntity } from '../../domain/task/task.js'
import { errors } from '../../shared/app-error.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { ConsentService } from '../consent/consent-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, Page, ReadRepository, UnitOfWork } from '../ports/persistence.js'
import { releaseLease } from './lease-service.js'
import type { WaitRequestEntity } from '../../domain/agent/wait-request.js'
import { waitLocation } from './wait-requests.js'
import type { Tx } from '../ports/persistence.js'
import type { AgentRunEventEntity } from '../../domain/agent/agent-run-event.js'
import { recordAcceptedEvent, recordRunTransitionEvent } from './agent-run-events.js'

async function cancelWait(tx: Tx, run: AgentRunEntity) {
  if (!run.activeWaitRequestId || !run.caseId) return
  const location = waitLocation(run.caseId, run.activeWaitRequestId)
  const wait = await tx.require<WaitRequestEntity>(location)
  tx.update<WaitRequestEntity>(location, wait.version, { state: 'CANCELLED' })
}

export interface AgentRunView {
  id: string
  caseId: string
  operation: AgentOperation
  status: AgentRunStatus
  targetType: AgentRunEntity['targetType']
  targetId: string
  attempt: number
  /** 待機中か。待機は失敗ではない。 */
  waiting: boolean
  waitingFor: string | null
  failureReason: string | null
  outcome: AgentRunOutcomeResource | null
  caseVersionAtAccept: number
  startedAt: string | null
  finishedAt: string | null
  /** いま実行できる操作。 */
  allowedActions: ('cancel' | 'retry')[]
  version: number
  createdAt: string
  updatedAt: string
}

function runLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.agentRuns, caseId, id }
}

export interface AgentRunEventView {
  id: string
  runId: string
  eventId: string
  kind: AgentRunEventEntity['kind']
  status: AgentRunStatus
  attempt: number
  sequence: number
  detail: Record<string, unknown>
  occurredAt: string
}

export function toAgentRunEventView(entity: AgentRunEventEntity): AgentRunEventView {
  return {
    id: entity.id,
    runId: entity.runId,
    eventId: entity.eventId,
    kind: entity.kind,
    status: entity.status,
    attempt: entity.attempt,
    sequence: entity.sequence,
    detail: entity.detail,
    occurredAt: entity.createdAt,
  }
}

export function toAgentRunView(entity: AgentRunEntity): AgentRunView {
  const allowedActions: ('cancel' | 'retry')[] = []
  if (canCancel(entity.status)) allowedActions.push('cancel')
  if (canRetry(entity.status)) allowedActions.push('retry')

  return {
    id: entity.id,
    caseId: entity.caseId ?? '',
    operation: entity.operation,
    status: entity.status,
    targetType: entity.targetType,
    targetId: entity.targetId,
    attempt: entity.attempt,
    waiting: isRunWaiting(entity.status),
    waitingFor: entity.waitingFor,
    failureReason: entity.failureReason,
    outcome: entity.outcome ?? null,
    caseVersionAtAccept: entity.caseVersionAtAccept,
    startedAt: entity.startedAt,
    finishedAt: entity.finishedAt,
    allowedActions,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

export interface AcceptRunInput {
  operation: AgentOperation
  targetType: AgentRunEntity['targetType']
  targetId: string
}

/**
 * AI 実行の受付と参照（仕様書 6.3）。
 *
 * 受け付けただけで完了ではない。結果は別途取得させる。
 * 対応していない業務操作は、理由を添えて拒否する。ボタンがあるだけで
 * すべての操作を有効にしない。
 */
export class AgentRunService {
  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    private readonly consent: ConsentService,
    /**
     * 接続済みの業務操作。
     *
     * 設定と公開契約で管理する。空なら、どの操作も受け付けない。
     */
    private readonly connectedOperations: ReadonlySet<AgentOperation> = new Set(),
  ) {}

  /** 202 で受け付ける。結果は後から取得する。 */
  async accept(
    user: AuthenticatedUser,
    caseId: string,
    input: AcceptRunInput,
    meta: CommandMeta,
  ): Promise<AgentRunView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    if (!this.connectedOperations.has(input.operation)) {
      throw errors.featureNotConnected({
        details: {
          operation: input.operation,
          connectedOperations: [...this.connectedOperations],
        },
      })
    }
    // 外部 AI へデータを渡す処理は、同意が無ければ受け付けない。
    await this.consent.assertExternalAiAllowed(user)

    const runId = randomUUID()
    const jobId = randomUUID()
    const storedId = await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const caseEntity = await tx.require<CaseEntity>({
        collection: collections.cases,
        caseId: null,
        id: caseId,
      })

      tx.create<AgentRunEntity>(runLocation(caseId, runId), {
        id: runId,
        operation: input.operation,
        status: 'QUEUED',
        targetType: input.targetType,
        targetId: input.targetId,
        // 結果の鮮度判定に使う。受付後に Case が変われば再計画が要る。
        caseVersionAtAccept: caseEntity.caseVersion,
        attempt: 1,
        currentAttemptId: randomUUID(),
        initiatedByUserId: user.userId,
        currentJobId: jobId,
        failureReason: null,
        waitingFor: null,
        startedAt: null,
        finishedAt: null,
        cancelRequestedBy: null,
      })

      if (input.operation === 'task_guidance') {
        if (input.targetType !== 'TASK') throw errors.validationFailed()
        await tx.require<TaskEntity>({ collection: collections.tasks, caseId, id: input.targetId })
        const location = { collection: collections.guidance, caseId, id: input.targetId }
        const current = await tx.get<GuidanceEntity>(location)
        const guidance = {
          taskId: input.targetId, status: 'RESEARCHING' as const, agentRunId: runId,
          researchedBy: 'AI' as const, failureReason: null, resultId: null, attemptId: null,
          target: null, where: null, bring: [], steps: [], formExampleUrl: null,
          formExampleLabel: null, note: null, sources: [], missing: [],
        }
        if (current) tx.update<GuidanceEntity>(location, current.version, guidance)
        else tx.create<GuidanceEntity>(location, { id: input.targetId, ...guidance })
        tx.audit({ caseId, type: 'guidance.requested',
          target: { collection: collections.guidance.name, id: input.targetId, version: (current?.version ?? 0) + 1 },
          detail: { runId } })
      }

      await recordAcceptedEvent(tx, caseId, runId, { operation: input.operation, targetType: input.targetType })

      tx.audit({
        caseId,
        type: 'agent_run.accepted',
        target: { collection: collections.agentRuns.name, id: runId, version: 1 },
        detail: { operation: input.operation, targetType: input.targetType },
      })

      // 配送は Outbox が行う。HTTP 応答の後処理にぶら下げない。
      tx.outbox({
        id: jobId,
        type: `agent.${input.operation}`,
        caseId,
        payload: {
          caseId,
          runId,
          operation: input.operation,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      })
      return runId
    })

    return this.get(user, caseId, storedId)
  }

  async get(user: AuthenticatedUser, caseId: string, runId: string): Promise<AgentRunView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const entity = await this.read.get<AgentRunEntity>(user.tenantId, runLocation(caseId, runId))
    if (!entity) throw errors.notFound()
    return toAgentRunView(entity)
  }

  async list(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<AgentRunView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<AgentRunEntity>(user.tenantId, collections.agentRuns, caseId, {
      limit: options.limit,
      cursor: options.cursor,
    })
    const items = page.items.map(toAgentRunView)
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  /**
   * 受付・処理中・待機・再開・完了の履歴を時系列で返す（Issue #125）。
   *
   * Case membershipを確認し、対象Runがこの Case に属することも確かめる。
   * 別Case・別Runのrun-idへ差し替えても、存在を明かさず NOT_FOUND を返す。
   */
  async listEvents(
    user: AuthenticatedUser,
    caseId: string,
    runId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<AgentRunEventView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const run = await this.read.get<AgentRunEntity>(user.tenantId, runLocation(caseId, runId))
    if (!run) throw errors.notFound()
    const page = await this.read.list<AgentRunEventEntity>(user.tenantId, collections.agentRunEvents, caseId, {
      limit: options.limit,
      cursor: options.cursor,
      orderBy: { field: 'sequence', direction: 'asc' },
      where: [{ field: 'runId', op: '==', value: runId }],
    })
    const items = page.items.map(toAgentRunEventView)
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  /**
   * 実行の取消。
   *
   * 取り消すのは実行であって、既に確定した業務変更ではない。
   * 確定済みの変更を戻す操作は別に用意する。
   */
  async cancel(
    user: AuthenticatedUser,
    caseId: string,
    runId: string,
    expectedVersion: number,
    meta: CommandMeta,
  ): Promise<AgentRunView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      if (isRunTerminal(current.status)) {
        throw errors.preconditionFailed({
          message: 'この実行は既に終了しています。',
          details: { status: current.status },
        })
      }
      const cancelId = randomUUID()
      const cancellation = current.currentJobId ? { cancelId, jobId: current.currentJobId, executionAttempt: current.currentAttemptId } : undefined
      tx.update<AgentRunEntity>(runLocation(caseId, runId), expectedVersion, {
        ...(cancellation ? { cancellation } : {}), status: 'CANCELLED',
        cancelRequestedBy: user.userId,
        finishedAt: new Date().toISOString(),
        // 取消後に届いた古い attempt の結果を受け付けないよう、世代を変える。
        currentAttemptId: randomUUID(),
      })
      if (cancellation) tx.outbox({ id: cancelId, type: 'agent.cancel', caseId, payload: { runId } })
      await cancelWait(tx, current)
      if (current.fencingToken) await releaseLease(tx, caseId, runId, current.fencingToken)
      await recordRunTransitionEvent(tx, { ...current, version: expectedVersion }, 'CANCELLED', 'CANCELLED', {
        eventId: cancelId, detail: { previousStatus: current.status },
      })
      tx.audit({
        caseId,
        type: 'agent_run.cancelled',
        target: { collection: collections.agentRuns.name, id: runId, version: expectedVersion + 1 },
        detail: { previousStatus: current.status },
      })
    })

    return this.get(user, caseId, runId)
  }

  async answerQuestions(user: AuthenticatedUser, caseId: string, runId: string,
    input: { expectedVersion: number; resultId: string; answers: { questionIndex: number; answer: string }[] },
    meta: CommandMeta): Promise<AgentRunView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    await this.consent.assertExternalAiAllowed(user)
    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async tx => {
      const member = await tx.get<CaseMember>({ collection: collections.caseMembers, caseId, id: user.userId })
      const tenant = await tx.get<TenantMember>({ collection: collections.members, caseId: null, id: user.userId })
      if (!member?.active || member.userId !== user.userId || !roleAllows(member.role, 'case.write') || !tenant?.active || tenant.userId !== user.userId) throw errors.forbidden()
      await this.consent.assertExternalAiAllowed(user, tx)
      const run = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: caseId })
      if (run.version !== input.expectedVersion || run.status !== 'NEEDS_ATTENTION' || run.operation !== 'case_planning'
        || !run.outcome || run.outcome.resultId !== input.resultId || run.outcome.attemptId !== run.currentAttemptId
        || run.outcome.caseVersion !== entity.caseVersion) throw errors.conflict({ details: { reason: 'STALE_QUESTIONS' } })
      if (entity.aiPlanningRestriction) throw errors.preconditionFailed({ details: { reason: 'AI_PLANNING_RESTRICTED' } })
      if (!input.answers.length || input.answers.length > 20 || new Set(input.answers.map(a => a.questionIndex)).size !== input.answers.length
        || input.answers.some(a => !Number.isInteger(a.questionIndex) || !run.outcome!.questions[a.questionIndex] || !a.answer.trim() || a.answer.length > 1000)) throw errors.validationFailed()
      const history = clarificationHistorySchema.safeParse([...(run.clarificationHistory ?? []), ...input.answers.map(a => ({
        resultId: input.resultId, questionIndex: a.questionIndex, question: run.outcome!.questions[a.questionIndex]!,
        answer: a.answer.trim(), caseVersion: entity.caseVersion + 1, state: 'user_reported',
      }))])
      if (!history.success) throw errors.preconditionFailed({ details: { reason: 'CLARIFICATION_HISTORY_LIMIT' } })
      const jobId = randomUUID(), attemptId = randomUUID()
      if (run.fencingToken) await releaseLease(tx, caseId, runId, run.fencingToken)
      await cancelWait(tx, run)
      for (const answer of input.answers) {
        const messageId = randomUUID()
        tx.create<MessageEntity>({ collection: collections.messages, caseId, id: messageId }, {
          id: messageId, role: 'user', body: `${run.outcome!.questions[answer.questionIndex]}\n${answer.answer.trim()}`,
          agentRunId: null, replyRunId: null, professionalNotice: false, escalationProposalId: null, resultId: null,
        })
      }
      // Message creation advances Case context once in the shared UnitOfWork.
      tx.update<AgentRunEntity>(runLocation(caseId, runId), run.version, {
        status: 'QUEUED', attempt: run.attempt + 1, currentAttemptId: attemptId, currentJobId: jobId,
        initiatedByUserId: user.userId, caseVersionAtAccept: entity.caseVersion + 1, clarificationHistory: history.data,
        progressSequence: -1, fencingToken: null, activeWaitRequestId: null,
        pendingResume: { kind: 'RETRY', previousAttemptId: run.currentAttemptId, snapshotId: null, waitRequestId: null, outcome: 'QUESTIONS_ANSWERED' },
        failureReason: null, waitingFor: null, finishedAt: null,
      })
      await recordRunTransitionEvent(tx, run, 'RETRIED', 'QUEUED', {
        eventId: jobId, attempt: run.attempt + 1, detail: { attempt: run.attempt + 1, outcome: 'QUESTIONS_ANSWERED' },
      })
      tx.audit({ caseId, type: 'agent_run.questions_answered', target: { collection: collections.agentRuns.name, id: runId, version: run.version + 1 }, detail: { resultId: input.resultId, answerCount: input.answers.length } })
      tx.outbox({ id: jobId, type: 'agent.case_planning', caseId, payload: { caseId, runId, operation: run.operation, targetType: run.targetType, targetId: run.targetId, attempt: run.attempt + 1 } })
    })
    return this.get(user, caseId, runId)
  }

  /**
   * 再試行。
   *
   * 成功済みの操作を再実行しない。新しい attempt を作り、
   * 古い attempt の遅れて届いた結果は受け付けない。
   */
  async retry(
    user: AuthenticatedUser,
    caseId: string,
    runId: string,
    expectedVersion: number,
    meta: CommandMeta,
  ): Promise<AgentRunView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    await this.consent.assertExternalAiAllowed(user)

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      if (!canRetry(current.status)) {
        throw errors.preconditionFailed({
          message: 'この状態では再試行できません。',
          details: { status: current.status },
        })
      }
      const caseEntity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: caseId })
      const jobId = randomUUID()
      if (current.fencingToken) await releaseLease(tx, caseId, runId, current.fencingToken)
      await cancelWait(tx, current)
      tx.update<AgentRunEntity>(runLocation(caseId, runId), expectedVersion, {
        status: 'QUEUED',
        attempt: current.attempt + 1,
        currentAttemptId: randomUUID(),
        currentJobId: jobId,
        initiatedByUserId: user.userId,
        caseVersionAtAccept: caseEntity.caseVersion,
        progressSequence: -1,
        fencingToken: null,
        activeWaitRequestId: null,
        pendingResume: { kind: 'RETRY', previousAttemptId: current.currentAttemptId, snapshotId: null, waitRequestId: null, outcome: 'USER_RETRY' },
        failureReason: null,
        waitingFor: null,
        finishedAt: null,
      })
      await recordRunTransitionEvent(tx, { ...current, version: expectedVersion }, 'RETRIED', 'QUEUED', {
        attempt: current.attempt + 1, detail: { attempt: current.attempt + 1 },
      })
      tx.audit({
        caseId,
        type: 'agent_run.retried',
        target: { collection: collections.agentRuns.name, id: runId, version: expectedVersion + 1 },
        detail: { attempt: current.attempt + 1 },
      })
      tx.outbox({
        id: jobId,
        type: `agent.${current.operation}`,
        caseId,
        payload: {
          caseId,
          runId,
          operation: current.operation,
          targetType: current.targetType,
          targetId: current.targetId,
          attempt: current.attempt + 1,
        },
      })
    })

    return this.get(user, caseId, runId)
  }
}
