import { randomUUID } from 'node:crypto'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { MessageEntity } from '../../domain/message/message.js'
import { collections } from '../../domain/shared/collections.js'
import type { GuidanceEntity, GuidanceSource } from '../../domain/task/guidance.js'
import type { TaskEntity } from '../../domain/task/task.js'
import { errors } from '../../shared/app-error.js'
import type { AgentRunService } from '../agent/agent-run-service.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, Page, ReadRepository, UnitOfWork } from '../ports/persistence.js'

export interface MessageView {
  id: string
  caseId: string
  role: 'user' | 'assistant'
  body: string
  agentRunId: string | null
  /** 利用者の発言に対して受け付けた回答の実行。 */
  replyRunId: string | null
  professionalNotice: boolean
  escalationProposalId: string | null
  createdAt: string
}

export interface GuidanceView {
  taskId: string
  status: GuidanceEntity['status']
  target: string | null
  where: string | null
  bring: string[]
  steps: string[]
  formExampleUrl: string | null
  formExampleLabel: string | null
  note: string | null
  sources: GuidanceSource[]
  /** 調べきれなかった項目。空でないときは全件確認済みではない。 */
  missing: string[]
  failureReason: string | null
  researchedBy: 'AI' | 'MANUAL' | null
  agentRunId: string | null
  version: number
  updatedAt: string
}

function messageLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.messages, caseId, id }
}

/** 手続きごとに 1 つ。Task の ID をそのまま文書 ID にする。 */
function guidanceLocation(caseId: string, taskId: string): DocLocation {
  return { collection: collections.guidance, caseId, id: taskId }
}

function toMessageView(entity: MessageEntity): MessageView {
  return {
    id: entity.id,
    caseId: entity.caseId ?? '',
    role: entity.role,
    body: entity.body,
    agentRunId: entity.agentRunId,
    replyRunId: entity.replyRunId,
    professionalNotice: entity.professionalNotice,
    escalationProposalId: entity.escalationProposalId,
    createdAt: entity.createdAt,
  }
}

export function toGuidanceView(entity: GuidanceEntity): GuidanceView {
  return {
    taskId: entity.taskId,
    status: entity.status,
    target: entity.target,
    where: entity.where,
    bring: entity.bring,
    steps: entity.steps,
    formExampleUrl: entity.formExampleUrl,
    formExampleLabel: entity.formExampleLabel,
    note: entity.note,
    sources: entity.sources,
    missing: entity.missing,
    failureReason: entity.failureReason,
    researchedBy: entity.researchedBy,
    agentRunId: entity.agentRunId,
    version: entity.version,
    updatedAt: entity.updatedAt,
  }
}

/**
 * チャットと手順案内の受付・保存・取得（仕様書 6.2）。
 *
 * 回答や案内は説明である。それだけで手続きを完了したり、正式な事実を
 * 登録したり、承認を作ったりしない。正式な変更が必要なら提案の経路を使う。
 */
export class MessageService {
  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    private readonly runs: AgentRunService,
  ) {}

  async list(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<MessageView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<MessageEntity>(user.tenantId, collections.messages, caseId, {
      limit: options.limit,
      cursor: options.cursor,
      orderBy: { field: 'createdAt', direction: 'asc' },
    })
    const items = page.items.map(toMessageView)
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  /**
   * 発言を保存し、回答の実行を受け付ける。
   *
   * 発言の保存と実行の受付を分けると、送信は成功したのに回答が
   * 始まらない状態や、その逆が起きる。同じ経路で扱う。
   */
  async post(
    user: AuthenticatedUser,
    caseId: string,
    body: string,
    meta: CommandMeta,
  ): Promise<{ message: MessageView; runId: string | null; runAccepted: boolean; reason: string | null }> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const messageId = randomUUID()

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      tx.create<MessageEntity>(messageLocation(caseId, messageId), {
        id: messageId,
        role: 'user',
        body,
        agentRunId: null,
        replyRunId: null,
        professionalNotice: false,
        escalationProposalId: null,
        resultId: null,
      })
      tx.audit({
        caseId,
        type: 'message.posted',
        target: { collection: collections.messages.name, id: messageId, version: 1 },
        detail: { role: 'user' },
      })
    })

    // 受付できない場合も発言は残す。送信が失敗したように見せない。
    let runId: string | null = null
    let reason: string | null = null
    try {
      const run = await this.runs.accept(
        user,
        caseId,
        { operation: 'chat_reply', targetType: 'MESSAGE', targetId: messageId },
        { requestId: meta.requestId, idempotency: null },
      )
      runId = run.id
      await this.attachReplyRun(user, caseId, messageId, run.id, meta)
    } catch (cause) {
      // 未接続・同意不足は失敗ではなく、回答が始まらない理由として返す。
      reason = (cause as { code?: string } | null)?.code ?? 'UNAVAILABLE'
    }

    const message = await this.requireMessage(user.tenantId, caseId, messageId)
    return {
      message: toMessageView(message),
      runId,
      runAccepted: runId !== null,
      reason,
    }
  }

  private async attachReplyRun(
    user: AuthenticatedUser,
    caseId: string,
    messageId: string,
    runId: string,
    meta: CommandMeta,
  ): Promise<void> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
      const current = await tx.require<MessageEntity>(messageLocation(caseId, messageId))
      tx.update<MessageEntity>(messageLocation(caseId, messageId), current.version, { replyRunId: runId })
    })
  }

  /** 手続きの案内を依頼する。公開されている業務操作としてのみ受け付ける。 */
  async requestGuidance(
    user: AuthenticatedUser,
    caseId: string,
    taskId: string,
    meta: CommandMeta,
  ): Promise<{ guidance: GuidanceView; runId: string }> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    // 対象の手続きが同じ案件にあることを確かめる。
    await this.requireTask(user.tenantId, caseId, taskId)

    const run = await this.runs.accept(
      user,
      caseId,
      { operation: 'task_guidance', targetType: 'TASK', targetId: taskId },
      { requestId: meta.requestId, idempotency: null },
    )

    await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
      const current = await tx.get<GuidanceEntity>(guidanceLocation(caseId, taskId))
      const patch = {
        status: 'RESEARCHING' as const,
        agentRunId: run.id,
        researchedBy: 'AI' as const,
        failureReason: null,
      }
      if (!current) {
        tx.create<GuidanceEntity>(guidanceLocation(caseId, taskId), {
          id: taskId,
          taskId,
          ...patch,
          target: null,
          where: null,
          bring: [],
          steps: [],
          formExampleUrl: null,
          formExampleLabel: null,
          note: null,
          sources: [],
          missing: [],
          resultId: null,
          attemptId: null,
        })
      } else {
        tx.update<GuidanceEntity>(guidanceLocation(caseId, taskId), current.version, patch)
      }
      tx.audit({
        caseId,
        type: 'guidance.requested',
        target: { collection: collections.guidance.name, id: taskId, version: (current?.version ?? 0) + 1 },
        detail: { runId: run.id },
      })
    })

    return { guidance: await this.getGuidance(user, caseId, taskId), runId: run.id }
  }

  async getGuidance(user: AuthenticatedUser, caseId: string, taskId: string): Promise<GuidanceView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const entity = await this.read.get<GuidanceEntity>(user.tenantId, guidanceLocation(caseId, taskId))
    if (!entity) {
      // 未依頼と依頼済みを区別する。空の成功を返さない。
      await this.requireTask(user.tenantId, caseId, taskId)
      return {
        taskId,
        status: 'NOT_REQUESTED',
        target: null,
        where: null,
        bring: [],
        steps: [],
        formExampleUrl: null,
        formExampleLabel: null,
        note: null,
        sources: [],
        missing: [],
        failureReason: null,
        researchedBy: null,
        agentRunId: null,
        version: 0,
        updatedAt: '',
      }
    }
    return toGuidanceView(entity)
  }

  private async requireTask(tenantId: string, caseId: string, taskId: string): Promise<TaskEntity> {
    const task = await this.read.get<TaskEntity>(tenantId, {
      collection: collections.tasks,
      caseId,
      id: taskId,
    })
    if (!task) throw errors.notFound()
    return task
  }

  private async requireMessage(
    tenantId: string,
    caseId: string,
    messageId: string,
  ): Promise<MessageEntity> {
    const entity = await this.read.get<MessageEntity>(tenantId, messageLocation(caseId, messageId))
    if (!entity) throw errors.notFound()
    return entity
  }
}

export { guidanceLocation, messageLocation }
export type { AgentRunEntity }
