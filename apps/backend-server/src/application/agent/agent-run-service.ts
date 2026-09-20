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
      tx.update<AgentRunEntity>(runLocation(caseId, runId), expectedVersion, {
        status: 'CANCELLED',
        cancelRequestedBy: user.userId,
        finishedAt: new Date().toISOString(),
        // 取消後に届いた古い attempt の結果を受け付けないよう、世代を変える。
        currentAttemptId: randomUUID(),
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
      tx.update<AgentRunEntity>(runLocation(caseId, runId), expectedVersion, {
        status: 'QUEUED',
        attempt: current.attempt + 1,
        currentAttemptId: randomUUID(),
        currentJobId: jobId,
        initiatedByUserId: user.userId,
        caseVersionAtAccept: caseEntity.caseVersion,
        progressSequence: -1,
        failureReason: null,
        waitingFor: null,
        finishedAt: null,
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
