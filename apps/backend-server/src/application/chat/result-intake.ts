import type { AgentOperation, AgentRunEntity } from '../../domain/agent/agent-run.js'
import { isRunTerminal } from '../../domain/agent/agent-run.js'
import type { MessageEntity } from '../../domain/message/message.js'
import { collections } from '../../domain/shared/collections.js'
import type { GuidanceEntity, GuidanceSource, GuidanceStatus } from '../../domain/task/guidance.js'
import { errors } from '../../shared/app-error.js'
import { AgentAccess } from '../authorization/case-access.js'
import type { DocLocation, ReadRepository, Tx, UnitOfWork } from '../ports/persistence.js'

/**
 * AI からの結果を受け取る（仕様書 6.3）。
 *
 * 保存済みの Run から scope を導出する。要求本文が名乗った tenant や
 * Case は使わない。重複と遅着の結果で最新の内容を上書きしない。
 *
 * ここは結果の受領だけを扱う。内部 API の全体像（context / artifact /
 * control / heartbeat / events）は #36 が整備する。
 */
export interface ResultEnvelope {
  runId: string
  /** どの試行の結果か。古い試行の結果は受け付けない。 */
  attemptId: string
  /** 結果の識別子。同じ値の再送は一度だけ反映する。 */
  resultId: string
}

export interface GuidanceResultInput extends ResultEnvelope {
  status: Extract<GuidanceStatus, 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'WAITING'>
  target?: string | null
  where?: string | null
  bring?: string[]
  steps?: string[]
  formExampleUrl?: string | null
  formExampleLabel?: string | null
  note?: string | null
  sources?: GuidanceSource[]
  /** 調べきれなかった項目。失うと全件確認済みだと誤解される。 */
  missing?: string[]
  failureReason?: string | null
}

export interface ChatReplyResultInput extends ResultEnvelope {
  body: string
  professionalNotice?: boolean
}

function guidanceLocation(caseId: string, taskId: string): DocLocation {
  return { collection: collections.guidance, caseId, id: taskId }
}

function messageLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.messages, caseId, id }
}

function runLocation(caseId: string, runId: string): DocLocation {
  return { collection: collections.agentRuns, caseId, id: runId }
}

/** 案内の状態から実行の状態を決める。部分成功を成功に丸めない。 */
function runStatusFor(status: GuidanceResultInput['status']): AgentRunEntity['status'] {
  if (status === 'COMPLETED') return 'SUCCEEDED'
  if (status === 'PARTIAL') return 'NEEDS_ATTENTION'
  if (status === 'WAITING') return 'WAITING_DOCUMENT'
  return 'FAILED'
}

export class AgentResultIntake {
  constructor(
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * 受領してよい結果かを確かめる。
   *
   * Run が別の Case のものだったり、取消済みだったり、古い試行の
   * ものだったりすれば受け付けない。
   */
  private async verifyRun(
    tenantId: string,
    caseId: string,
    envelope: ResultEnvelope,
    operation: AgentOperation,
  ): Promise<AgentRunEntity> {
    const run = await this.read.get<AgentRunEntity>(tenantId, runLocation(caseId, envelope.runId))
    // 別 Case の runId へ差し替えても、パスが違うため見つからない。
    if (!run) throw errors.notFound()

    this.assertRun(run, envelope, operation)
    return run
  }

  private assertRun(run: AgentRunEntity, envelope: ResultEnvelope, operation: AgentOperation): void {
    if (run.operation !== operation) {
      throw errors.preconditionFailed({
        message: 'この実行の種類では受け付けられない結果です。',
        details: { reason: 'OPERATION_MISMATCH' },
      })
    }
    if (isRunTerminal(run.status)) {
      // 取消後や完了後に届いた結果を適用しない。
      throw errors.conflict({
        message: 'この実行は既に終了しています。',
        details: { reason: 'RUN_ALREADY_FINISHED', status: run.status },
      })
    }
    if (run.currentAttemptId !== envelope.attemptId) {
      throw errors.conflict({
        message: 'この結果は古い試行のものです。',
        details: { reason: 'STALE_ATTEMPT' },
      })
    }
  }

  async submitGuidanceResult(
    tenantId: string,
    caseId: string,
    input: GuidanceResultInput,
  ): Promise<{ applied: boolean; reason: string | null }> {
    // 重複の判定を先に行う。配送は少なくとも 1 回を前提にしており、
    // 同じ結果の再送はエラーではなく「適用済み」として扱う。
    const duplicate = await this.findGuidanceByResultId(tenantId, caseId, input)
    if (duplicate) return { applied: false, reason: 'DUPLICATE_RESULT' }

    const run = await this.verifyRun(tenantId, caseId, input, 'task_guidance')
    const access = new AgentAccess(tenantId, caseId, run.id)

    return this.uow.run(access.toWorkContext(null), tx => this.applyGuidanceResult(tx, caseId, input))
  }

  /** 内部APIの認可・Receiptと同じTransactionで適用する。 */
  async applyGuidanceResult(tx: Tx, caseId: string, input: GuidanceResultInput) {
    const runEntity = await tx.require<AgentRunEntity>(runLocation(caseId, input.runId))
    const taskId = runEntity.targetId
    const current = await tx.get<GuidanceEntity>(guidanceLocation(caseId, taskId))
    if (!current) {
      throw errors.preconditionFailed({
        message: '対象の案内が見つかりません。',
        details: { reason: 'GUIDANCE_NOT_REQUESTED' },
      })
    }
    if (current.agentRunId !== runEntity.id) {
      throw errors.conflict({ details: { reason: 'GUIDANCE_SUPERSEDED' } })
    }
    if (current.resultId === input.resultId && current.attemptId === input.attemptId) {
      // 同じ結果の再送。二重に反映しない。
      return { applied: false, reason: 'DUPLICATE_RESULT' }
    }
    // 必ず保存と同じ Transaction で再検証する。取消・retryとの競合時にも有効。
    this.assertRun(runEntity, input, 'task_guidance')

    tx.update<GuidanceEntity>(guidanceLocation(caseId, taskId), current.version, {
      status: input.status,
      target: input.target ?? current.target,
      where: input.where ?? null,
      bring: input.bring ?? [],
      steps: input.steps ?? [],
      formExampleUrl: input.formExampleUrl ?? null,
      formExampleLabel: input.formExampleLabel ?? null,
      note: input.note ?? null,
      sources: input.sources ?? [],
      // 調べきれなかった項目を落とさない。
      missing: input.missing ?? [],
      failureReason: input.failureReason ?? null,
      researchedBy: 'AI',
      resultId: input.resultId,
      attemptId: input.attemptId,
    })

    tx.update<AgentRunEntity>(runLocation(caseId, runEntity.id), runEntity.version, {
      status: runStatusFor(input.status),
      finishedAt: input.status === 'WAITING' ? null : new Date().toISOString(),
      waitingFor: input.status === 'WAITING' ? '書類の登録' : null,
      failureReason: input.failureReason ?? null,
    })

    tx.audit({
      caseId,
      type: 'guidance.result_received',
      target: { collection: collections.guidance.name, id: taskId, version: current.version + 1 },
      detail: { status: input.status, sourceCount: (input.sources ?? []).length },
    })

    return { applied: true, reason: null }
  }

  /** 案内の結果が既に反映済みかを調べる。 */
  private async findGuidanceByResultId(
    tenantId: string,
    caseId: string,
    input: GuidanceResultInput,
  ): Promise<GuidanceEntity | null> {
    const run = await this.read.get<AgentRunEntity>(tenantId, runLocation(caseId, input.runId))
    if (!run) return null
    const guidance = await this.read.get<GuidanceEntity>(
      tenantId,
      guidanceLocation(caseId, run.targetId),
    )
    return guidance?.agentRunId === run.id && guidance.resultId === input.resultId
      && guidance.attemptId === input.attemptId ? guidance : null
  }

  async submitChatReply(
    tenantId: string,
    caseId: string,
    input: ChatReplyResultInput,
  ): Promise<{ applied: boolean; reason: string | null }> {
    // 同じ結果 ID からは同じ発言 ID になる。再送で発言が増えない。
    const replyId = `reply-${input.resultId}`
    // 重複の判定を先に行う。配送は少なくとも 1 回を前提にしており、
    // 同じ結果の再送はエラーではなく「適用済み」として扱う。
    const duplicate = await this.read.get<MessageEntity>(tenantId, messageLocation(caseId, replyId))
    if (duplicate) return this.chatDuplicate(duplicate, input)

    const run = await this.verifyRun(tenantId, caseId, input, 'chat_reply')
    const access = new AgentAccess(tenantId, caseId, run.id)

    return this.uow.run(access.toWorkContext(null), tx => this.applyChatReply(tx, caseId, input))
  }

  async applyChatReply(tx: Tx, caseId: string, input: ChatReplyResultInput) {
    const replyId = `reply-${input.resultId}`
    const existing = await tx.get<MessageEntity>(messageLocation(caseId, replyId))
    if (existing) return this.chatDuplicate(existing, input)
    const runEntity = await tx.require<AgentRunEntity>(runLocation(caseId, input.runId))
    this.assertRun(runEntity, input, 'chat_reply')

    tx.create<MessageEntity>(messageLocation(caseId, replyId), {
      id: replyId,
      role: 'assistant',
      body: input.body,
      agentRunId: runEntity.id,
      replyRunId: null,
      professionalNotice: input.professionalNotice ?? false,
      // 回答は説明であり、提案を作らない。正式な変更は提案の経路を使う。
      escalationProposalId: null,
      resultId: input.resultId,
      attemptId: input.attemptId,
    })

    tx.update<AgentRunEntity>(runLocation(caseId, runEntity.id), runEntity.version, {
      status: 'SUCCEEDED',
      finishedAt: new Date().toISOString(),
    })

    tx.audit({
      caseId,
      type: 'message.reply_received',
      target: { collection: collections.messages.name, id: replyId, version: 1 },
      detail: { runId: runEntity.id },
    })

    return { applied: true, reason: null }
  }

  private chatDuplicate(message: MessageEntity, input: ChatReplyResultInput) {
    if (message.agentRunId !== input.runId || (message.attemptId && message.attemptId !== input.attemptId)) {
      throw errors.conflict({ details: { reason: 'RESULT_ID_CONFLICT' } })
    }
    return { applied: false, reason: 'DUPLICATE_RESULT' }
  }
}
