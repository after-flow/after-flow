import { Mastra } from '@mastra/core/mastra'
import type { MastraCompositeStore } from '@mastra/core/storage'
import type { WorkflowRunState } from '@mastra/core/workflows'
import { artifactEnvelopeSchema, contextProofSchema } from '@aftercare/internal-contracts'
import { createProcedureGuidanceWorkflow, PROCEDURE_GUIDANCE_WORKFLOW } from '../mastra/workflows/procedure-guidance.js'
import type { ProcedureGuidanceDependencies } from '../mastra/workflows/procedure-guidance.js'
import { createChatReplyWorkflow } from '../mastra/workflows/chat-reply.js'
import type { ChatReplyDependencies } from '../mastra/workflows/chat-reply.js'
import { createDocumentReviewWorkflow, DOCUMENT_REVIEW_WORKFLOW } from '../mastra/workflows/document-review.js'
import { documentReviewSchema, extractionSchema, processedDocumentSchema } from '../../orchestration/documents/review.js'
import type { ProcessedDocument } from '../../orchestration/documents/review.js'
import { draftProposalsFromCandidates } from '../../orchestration/documents/proposal-mapping.js'
import type { BackendClient } from '../backend-client/client.js'
import type { AgentBudget } from '../mastra/budget-processors.js'
import { contentHash } from '../../orchestration/context/builder.js'
import type { ExecutionSession, WorkflowHandler } from './runtime.js'
import { createPlanningExecutionWorkflow, PLANNING_EXECUTION } from '../mastra/workflows/planning-execution.js'
import { createPlaybookAgents } from '../mastra/agents/guidance-agents.js'
import type { GuidanceAgentDependencies } from '../mastra/agents/guidance-agents.js'
import type { FirestoreWorkflowsStorage } from '../runtime-storage/workflows.js'
import { assertAuthorizedModelSet } from '../mastra/authorized-models.js'
import { ClassifiedExecutionError, classifyWorkflowFailure } from '../../application/execution/contracts.js'

type Prepared<T> = Omit<T, 'backend' | 'signal' | 'budget'> & { budget: AgentBudget }
interface HandlerConfig<T> {
  storage: MastraCompositeStore
  /** Resolve reviewed scope/catalog and real Orch-authorized, budgeted models for this section. */
  prepare(session: ExecutionSession): Promise<Prepared<T>>
}
export function guidanceWorkflowAction(status: WorkflowRunState['status'] | null): 'start' | 'restart' | 'complete' | 'fail' {
  if (status === null || status === 'pending') return 'start'
  if (status === 'running') return 'restart'
  if (status === 'success') return 'complete'
  return 'fail'
}
const workflowFailure = (result: { status: string } & Record<string, unknown>) =>
  new ClassifiedExecutionError(classifyWorkflowFailure('error' in result ? result.error : result.status))
function bindBudget(prepared: Pick<GuidanceAgentDependencies, 'models'> & { budget: AgentBudget }, session: ExecutionSession): AgentBudget {
  if (prepared.budget.inferenceChargedByProviderAdapter || Array.isArray(prepared.models.core) || Array.isArray(prepared.models.research)) {
    assertAuthorizedModelSet(prepared.models.core, { charge: session.guard, role: 'core', operation: session.receipt.operation })
    assertAuthorizedModelSet(prepared.models.research, { charge: session.guard, role: 'research', operation: session.receipt.operation })
    return { ...prepared.budget, onLimit: session.exhaust, inferenceChargedByProviderAdapter: true, charge: session.guard }
  }
  return { ...prepared.budget, onLimit: session.exhaust, charge: session.guard }
}
export function createGuidanceHandler(config: HandlerConfig<ProcedureGuidanceDependencies> & { snapshots: FirestoreWorkflowsStorage }): WorkflowHandler {
  return { workflowName: PROCEDURE_GUIDANCE_WORKFLOW, async execute(session) {
    await session.guard()
    if (session.receipt.resume?.kind === 'WAIT') throw new Error('Guidance does not define approval waits')
    const prepared = await config.prepare(session)
    const workflow = createProcedureGuidanceWorkflow({ ...prepared, budget: bindBudget(prepared, session), backend: session.backend, signal: session.signal })
    const mastra = new Mastra({ storage: config.storage, workflows: { workflow } })
    const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
    const resultId = contentHash({ jobId: session.receipt.jobId, kind: 'guidance-result' })
    const snapshot = await config.snapshots.loadWorkflowSnapshot({ workflowName: PROCEDURE_GUIDANCE_WORKFLOW, runId: session.receipt.workflowRunId })
    const action = guidanceWorkflowAction(snapshot?.status ?? null)
    const result = action === 'restart'
      ? await run.restart()
      : action === 'complete'
        ? { status: 'success' as const }
        : action === 'start'
          ? await run.start({ inputData: { resultId } })
          : { status: 'failed' as const }
    if (result.status !== 'success') throw workflowFailure(result)
    return 'COMPLETED'
  } }
}
export function createChatHandler(config: HandlerConfig<ChatReplyDependencies>): WorkflowHandler {
  return { workflowName: 'chat-reply-v1', async execute(session) {
    await session.guard()
    if (session.receipt.resume?.kind === 'WAIT') throw new Error('Chat does not define approval waits')
    const prepared = await config.prepare(session)
    const workflow = createChatReplyWorkflow({ ...prepared, budget: bindBudget(prepared, session), backend: session.backend, signal: session.signal })
    const mastra = new Mastra({ storage: config.storage, workflows: { workflow } })
    const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
    const resultId = contentHash({ jobId: session.receipt.jobId, kind: 'chat-result' })
    const result = await run.start({ inputData: { resultId } })
    if (result.status !== 'success') throw workflowFailure(result)
    return 'COMPLETED'
  } }
}

export function createPlanningHandler(config: {
  storage: MastraCompositeStore; snapshots: FirestoreWorkflowsStorage
  templates: Parameters<typeof createPlanningExecutionWorkflow>[0]['templates']; maxSourceAgeMs: number
  prepare(session: ExecutionSession): Promise<Awaited<ReturnType<Parameters<typeof createPlanningExecutionWorkflow>[0]['prepare']>> & { agents: GuidanceAgentDependencies & { budget: AgentBudget } }>
}): WorkflowHandler {
  return { workflowName: PLANNING_EXECUTION, async execute(session) {
    await session.guard()
    const workflow = createPlanningExecutionWorkflow({ backend: session.backend, signal: session.signal, guard: session.guard,
      checkpoint: session.checkpoint, previousAttemptId: session.receipt.resume?.previousAttemptId ?? null, allowedKinds: ['TASK_PROPOSAL'], registerWait: session.registerWait,
      templates: config.templates, maxSourceAgeMs: config.maxSourceAgeMs,
      prepare: async () => { const prepared = await config.prepare(session); return { ...prepared, agents: { ...prepared.agents, budget: bindBudget(prepared.agents, session) } } },
    })
    const mastra = new Mastra({ storage: config.storage, workflows: { workflow } })
    const resume = session.receipt.resume
    if (resume?.kind === 'WAIT') {
      if (!resume.snapshotId) throw new Error('Planning resume requires a durable snapshot')
      await config.snapshots.forkSuspendedSnapshot({ workflowName: PLANNING_EXECUTION, fromRunId: resume.snapshotId, toRunId: session.receipt.workflowRunId })
    } else if (resume?.kind === 'RETRY') {
      // A user-authorized full replan uses fresh Context/history, the same Run budget and a new workflow ID.
      await session.guard({ replans: 1 })
    } else if (resume) throw new Error('Planning replay requires explicit recovery policy')
    const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
    const result = resume?.kind === 'WAIT' ? await run.resume({ resumeData: { resume: true } }) :
      await run.start({ inputData: { runId: session.receipt.runId, resultId: contentHash({ runId: session.receipt.runId, jobId: session.receipt.jobId, kind: 'planning-result' }) } })
    if (result.status === 'suspended') return 'WAITING'
    if (result.status !== 'success') throw workflowFailure(result)
    return 'COMPLETED'
  } }
}

/** Backend context()のdocument_analysis用content内、書類を特定する型付きフィールドだけを検証する。 */
const documentContentSchema = processedDocumentSchema
  .pick({ caseId: true, documentId: true, documentVersion: true, inspectedDocumentVersion: true, inspection: true, maskingPolicyVersion: true, pages: true, fields: true })
  .passthrough()

/** Backend context()のdocument_analysis用contentから、Document配送に必要なscopeだけを取り出す。 */
function documentScopeFromContext(content: Record<string, unknown>, runId: string) {
  const parsed = documentContentSchema.parse(content)
  return { caseId: parsed.caseId, runId, documentId: parsed.documentId, documentVersion: parsed.documentVersion }
}

/** BackendのContext envelopeをProcessedDocumentへ組み立てる。pagesのcontentHashはここで計算する。 */
async function deliverDocument(backend: Pick<BackendClient, 'context'>, runId: string, signal: AbortSignal): Promise<ProcessedDocument> {
  const artifact = artifactEnvelopeSchema.parse(await backend.context({ signal }))
  const content = documentContentSchema.parse(artifact.content)
  return {
    caseId: content.caseId, runId, documentId: content.documentId, documentVersion: content.documentVersion,
    caseVersion: artifact.caseVersion, artifactId: artifact.contextSnapshotId, artifactVersion: artifact.artifactVersion,
    inspectedDocumentVersion: content.inspectedDocumentVersion, inspection: content.inspection,
    maskingPolicyVersion: content.maskingPolicyVersion, expiresAt: artifact.expiresAt,
    contentHash: contentHash(content.pages), pages: content.pages, fields: content.fields,
  }
}

/**
 * 書類の読み取り（document_analysis, #196）。
 *
 * 抽出候補はrunの途中でBackendへ`proposals` scope経由で提出する（承認待ちは個々のApprovalが持つ。
 * runはcase_planningと違って個々の承認を待たずに終える）。runの完了自体は候補が0件でも成功として報告する。
 */
export function createDocumentAnalysisHandler(config: HandlerConfig<GuidanceAgentDependencies>): WorkflowHandler {
  return { workflowName: DOCUMENT_REVIEW_WORKFLOW, async execute(session) {
    await session.guard()
    // 中断からの再開（WAIT）は無い。ユーザーによる再試行（RETRY）は新しいworkflowRunIdで素直にやり直す。
    if (session.receipt.resume?.kind === 'WAIT') throw new Error('Document analysis does not define approval waits')
    const prepared = await config.prepare(session)
    const budget = bindBudget(prepared, session)

    const scope = documentScopeFromContext(session.context.content as Record<string, unknown>, session.receipt.runId)
    const workflow = createDocumentReviewWorkflow({
      signal: session.signal, guard: session.guard,
      deliver: (_scope, signal) => deliverDocument(session.backend, session.receipt.runId, signal),
      extract: async (document, signal) => {
        // 専用の第三Agentは作らない。書類レビューもguidance/planningと同じCore/Research構成
        // （createPlaybookAgents）を使い、検索対象のbriefが無いだけ（Researchへは委任しない）。
        const agents = createPlaybookAgents({ ...prepared, budget, signal, playbookId: 'document-review' })
        const response = await agents.coreAgent.generate(JSON.stringify({
          goal: '配信された書類のページ本文（pages）から、読み取り対象フィールド（fields）の候補を、本文中の完全一致する引用（quote）と位置（page/start/end）つきで抽出してください。本文に無い値は推測せず、読み取れないフィールドはunreadableFieldsに入れてください。',
          fields: document.fields.map(field => ({ id: field.id, label: field.label, required: field.required })),
          pages: document.pages,
        }), { structuredOutput: { schema: extractionSchema, errorStrategy: 'strict' }, abortSignal: signal })
        return extractionSchema.parse(response.object)
      },
    })
    const mastra = new Mastra({ storage: config.storage, workflows: { workflow } })
    const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
    const result = await run.start({ inputData: scope })
    if (result.status !== 'success') throw workflowFailure(result)
    const review = documentReviewSchema.parse(result.result)

    await session.guard()
    const latest = artifactEnvelopeSchema.parse(await session.backend.context({ signal: session.signal }))
    const latestContent = documentContentSchema.parse(latest.content)
    const proof = contextProofSchema.parse(latest)
    const basis = [{ type: 'DOCUMENT' as const, id: latestContent.documentId, version: latestContent.documentVersion, label: latestContent.documentId }]
    const drafts = draftProposalsFromCandidates(review)
    for (const [index, draft] of drafts.entries()) {
      await session.guard()
      await session.backend.propose({ ...proof, proposalId: `${session.receipt.runId}-asset-${index}`, kind: draft.kind,
        title: draft.title, summary: draft.summary, payload: draft.payload, basis, assetDisposal: false },
      { requestId: `${session.receipt.jobId}-propose-${index}`, signal: session.signal })
    }

    await session.guard()
    const resultId = contentHash({ jobId: session.receipt.jobId, kind: 'document-analysis-result' })
    await session.backend.result({ ...proof, resultId, basis: [], kind: 'document_analysis', status: 'SUCCEEDED' },
      { requestId: resultId, signal: session.signal })
    return 'COMPLETED'
  } }
}
