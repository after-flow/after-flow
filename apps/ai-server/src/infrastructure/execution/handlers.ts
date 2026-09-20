import { Mastra } from '@mastra/core/mastra'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { createProcedureGuidanceWorkflow } from '../mastra/workflows/procedure-guidance.js'
import type { ProcedureGuidanceDependencies } from '../mastra/workflows/procedure-guidance.js'
import { createChatReplyWorkflow } from '../mastra/workflows/chat-reply.js'
import type { ChatReplyDependencies } from '../mastra/workflows/chat-reply.js'
import type { AgentBudget } from '../mastra/budget-processors.js'
import { contentHash } from '../../orchestration/context/builder.js'
import type { ExecutionSession, WorkflowHandler } from './runtime.js'
import { assertAuthorizedModelSet } from '../mastra/authorized-models.js'

type Prepared<T> = Omit<T, 'backend' | 'signal' | 'budget'> & { budget: AgentBudget }
interface HandlerConfig<T> {
  storage: MastraCompositeStore
  /** Resolve reviewed scope/catalog and real Orch-authorized, budgeted models for this section. */
  prepare(session: ExecutionSession): Promise<Prepared<T>>
}
function bindBudget(prepared: Prepared<ProcedureGuidanceDependencies> | Prepared<ChatReplyDependencies>, session: ExecutionSession): AgentBudget {
  if (prepared.budget.inferenceChargedByProviderAdapter || Array.isArray(prepared.models.core) || Array.isArray(prepared.models.research)) {
    assertAuthorizedModelSet(prepared.models.core, { charge: session.guard, role: 'core', operation: session.receipt.operation })
    assertAuthorizedModelSet(prepared.models.research, { charge: session.guard, role: 'research', operation: session.receipt.operation })
    return { ...prepared.budget, inferenceChargedByProviderAdapter: true, charge: session.guard }
  }
  return { ...prepared.budget, charge: session.guard }
}
export function createGuidanceHandler(config: HandlerConfig<ProcedureGuidanceDependencies>): WorkflowHandler {
  return { workflowName: 'procedure-guidance-v1', async execute(session) {
    await session.guard()
    if (session.receipt.resume?.kind === 'WAIT') throw new Error('Guidance does not define approval waits')
    const prepared = await config.prepare(session)
    const workflow = createProcedureGuidanceWorkflow({ ...prepared, budget: bindBudget(prepared, session), backend: session.backend, signal: session.signal })
    const mastra = new Mastra({ storage: config.storage, workflows: { workflow } })
    const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
    const resultId = contentHash({ jobId: session.receipt.jobId, kind: 'guidance-result' })
    const result = await run.start({ inputData: { resultId } })
    if (result.status !== 'success') throw new Error('Guidance workflow did not complete')
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
    if (result.status !== 'success') throw new Error('Chat workflow did not complete')
    return 'COMPLETED'
  } }
}
