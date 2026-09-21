import { Mastra } from '@mastra/core/mastra'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { createProcedureGuidanceWorkflow } from '../mastra/workflows/procedure-guidance.js'
import type { ProcedureGuidanceDependencies } from '../mastra/workflows/procedure-guidance.js'
import { createChatReplyWorkflow } from '../mastra/workflows/chat-reply.js'
import type { ChatReplyDependencies } from '../mastra/workflows/chat-reply.js'
import type { AgentBudget } from '../mastra/budget-processors.js'
import { contentHash } from '../../orchestration/context/builder.js'
import type { ExecutionSession, WorkflowHandler } from './runtime.js'
import { createPlanningExecutionWorkflow, PLANNING_EXECUTION } from '../mastra/workflows/planning-execution.js'
import type { GuidanceAgentDependencies } from '../mastra/agents/guidance-agents.js'
import type { FirestoreWorkflowsStorage } from '../runtime-storage/workflows.js'
import { assertAuthorizedModelSet } from '../mastra/authorized-models.js'

type Prepared<T> = Omit<T, 'backend' | 'signal' | 'budget'> & { budget: AgentBudget }
interface HandlerConfig<T> {
  storage: MastraCompositeStore
  /** Resolve reviewed scope/catalog and real Orch-authorized, budgeted models for this section. */
  prepare(session: ExecutionSession): Promise<Prepared<T>>
}
function bindBudget(prepared: Pick<GuidanceAgentDependencies, 'models'> & { budget: AgentBudget }, session: ExecutionSession): AgentBudget {
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

export function createPlanningHandler(config: {
  storage: MastraCompositeStore; snapshots: FirestoreWorkflowsStorage
  templates: Parameters<typeof createPlanningExecutionWorkflow>[0]['templates']; maxSourceAgeMs: number
  prepare(session: ExecutionSession): Promise<Awaited<ReturnType<Parameters<typeof createPlanningExecutionWorkflow>[0]['prepare']>> & { agents: GuidanceAgentDependencies & { budget: AgentBudget } }>
}): WorkflowHandler {
  return { workflowName: PLANNING_EXECUTION, async execute(session) {
    await session.guard()
    const workflow = createPlanningExecutionWorkflow({ backend: session.backend, signal: session.signal, guard: session.guard,
      previousAttemptId: session.receipt.resume?.previousAttemptId ?? null, allowedKinds: ['TASK_PROPOSAL'], registerWait: session.registerWait,
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
      await run.start({ inputData: { runId: session.receipt.runId, resultId: contentHash({ runId: session.receipt.runId, kind: 'planning-result' }) } })
    if (result.status === 'suspended') return 'WAITING'
    if (result.status !== 'success') throw new Error('Planning execution did not complete')
    return 'COMPLETED'
  } }
}
