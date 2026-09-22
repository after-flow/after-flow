import { fingerprintOf } from '../../shared/fingerprint.js'
import { randomUUID } from 'node:crypto'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { MessageEntity } from '../../domain/message/message.js'
import { collections } from '../../domain/shared/collections.js'
import type { GuidanceCitation, GuidanceEntity, GuidanceOutcome, GuidanceSource } from '../../domain/task/guidance.js'
import type { TaskEntity } from '../../domain/task/task.js'
import { errors, isAppError } from '../../shared/app-error.js'
import type { AgentRunService, AgentRunView } from '../agent/agent-run-service.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { ConsentService } from '../consent/consent-service.js'
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

/** 発言の受付結果。矛盾した状態を型で作れないようにする（#215）。 */
export type MessageAcceptedView =
  | { message: MessageView; runAccepted: true; runId: string; reason: null }
  | { message: MessageView; runAccepted: false; runId: null; reason: 'FEATURE_NOT_CONNECTED' }

export interface GuidanceView {
  taskId: string
  status: GuidanceEntity['status']
  outcome: GuidanceOutcome | null
  target: string | null
  where: string | null
  bring: string[]
  steps: string[]
  formExampleUrl: string | null
  formExampleLabel: string | null
  note: string | null
  sources: GuidanceSource[]
  /** 項目ごとの根拠となる公式資料の引用。 */
  citations: GuidanceCitation[]
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
  const outcome = entity.outcome ?? null
  return {
    taskId: entity.taskId,
    status: entity.status,
    outcome,
    target: entity.target,
    where: entity.where,
    bring: entity.bring,
    steps: entity.steps,
    formExampleUrl: entity.formExampleUrl,
    formExampleLabel: entity.formExampleLabel,
    note: entity.note,
    sources: entity.sources,
    citations: entity.citations ?? [],
    missing: entity.missing,
    failureReason: entity.failureReason,
    researchedBy: entity.researchedBy === 'MANUAL'
      ? 'MANUAL'
      : outcome === 'COMPLETED_RESEARCH' ? 'AI' : null,
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
    private readonly consent: ConsentService,
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
   *
   * 外部AI（回答の生成）へ渡す前提の発言のため、保存より前に同意を
   * 検査する。同意が無い利用者の発言を先に保存してしまうと、拒否は
   * 副作用の後になる。`accept()` 内でも同じ検査をもう一度行うため
   * 同意記録を二度読むが、意図的な二重化である。ここでの検査と
   * `accept()` の検査の間に撤回が割り込む競合窓を狭める。
   */
  async post(
    user: AuthenticatedUser,
    caseId: string,
    body: string,
    meta: CommandMeta,
  ): Promise<MessageAcceptedView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    await this.consent.assertExternalAiAllowed(user)
    const generatedId = randomUUID()

    const messageId = await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      tx.create<MessageEntity>(messageLocation(caseId, generatedId), {
        id: generatedId,
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
        target: { collection: collections.messages.name, id: generatedId, version: 1 },
        detail: { role: 'user' },
      })
      return generatedId
    })

    // 受付できない場合も発言は残す。送信が失敗したように見せない。
    // ただし「未接続」だけをRun未受付結果として202に丸める。予期しない
    // 失敗や通常のAPIエラーまで runAccepted:false へ潰さず、そのまま投げる。
    // try は accept() だけを囲む。accept() の後（attachReplyRun 等）で
    // 起きた失敗まで「未受付」に丸めると、実際には作られた Run が
    // runAccepted:false として返ってしまう。
    let run: AgentRunView
    try {
      run = await this.runs.accept(
        user,
        caseId,
        { operation: 'chat_reply', targetType: 'MESSAGE', targetId: messageId },
        { requestId: meta.requestId, idempotency: {
          key: 'chat-run-' + messageId, fingerprint: fingerprintOf({ operation: 'chat_reply', caseId, messageId }),
        } },
      )
    } catch (cause) {
      if (!isAppError(cause) || cause.code !== 'FEATURE_NOT_CONNECTED') throw cause
      const message = await this.requireMessage(user.tenantId, caseId, messageId)
      return { message: toMessageView(message), runAccepted: false, runId: null, reason: 'FEATURE_NOT_CONNECTED' }
    }

    await this.attachReplyRun(user, caseId, messageId, run.id, meta)
    const message = await this.requireMessage(user.tenantId, caseId, messageId)
    return { message: toMessageView(message), runAccepted: true, runId: run.id, reason: null }
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
      if (current.replyRunId === runId) return
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
    // 対象の手続きが同じ案件にあることを確かめる。
    await this.access.authorizeCase(user, caseId, 'case.write')
    await this.requireTask(user.tenantId, caseId, taskId)

    const run = await this.runs.accept(
      user,
      caseId,
      { operation: 'task_guidance', targetType: 'TASK', targetId: taskId },
      meta,
    )

    // Run、案内の所有権、配送Outboxは accept 内で原子的に保存する。
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
        outcome: null,
        target: null,
        where: null,
        bring: [],
        steps: [],
        formExampleUrl: null,
        formExampleLabel: null,
        note: null,
        sources: [],
        citations: [],
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
