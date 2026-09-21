import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContextArtifact } from '@aftercare/internal-contracts'
import { BackendClient, validateBackendClientConfig } from '../backend-client/client.js'
import type { BackendClientConfig } from '../backend-client/client.js'
import { createRuntimeFirestore } from '../runtime-storage/firestore.js'
import { FirestoreExecutions } from '../runtime-storage/executions.js'
import { createRuntimeStore, FirestoreWorkflowsStorage } from '../runtime-storage/workflows.js'
import { DispatchVault } from '../runtime-storage/credential-vault.js'
import { budgetSchema } from '../../application/execution/contracts.js'
import type { Budget } from '../../application/execution/contracts.js'
import { DurableExecutionRuntime } from './runtime.js'
import type { ExecutionSession } from './runtime.js'
import { startExecutionHost } from './host.js'
import { createChatHandler, createGuidanceHandler, createPlanningHandler } from './handlers.js'
import { createAuthorizedModels, createAuthorizedOrcaModels } from '../mastra/authorized-models.js'
import type { ProviderMetric } from '../mastra/authorized-models.js'
import { inferenceReservation, providerPolicySchema } from '../../orchestration/models/policy.js'
import type { OrchRouter, ProviderGrant, ProviderPolicy } from '../../orchestration/models/policy.js'
import { createOfficialCatalogProvider, officialCatalogSchema } from '../research/official-catalog.js'
import type { OfficialCatalog } from '../research/official-catalog.js'
import { reviewedResearchScopeSchema, buildPlanningContext, buildResearchBrief } from '../../orchestration/context/builder.js'
import { reviewedTaskTemplateSchema } from '../../orchestration/playbooks/planning-output.js'
import type { ReviewedTaskTemplate } from '../../orchestration/playbooks/planning-output.js'
import { createResearchTools } from '../mastra/tools/research.js'
import { createOrcaModel } from '../orcarouter/models.js'
import type { AgentBudget } from '../mastra/budget-processors.js'

/** Trusted deployment configuration. None of these functions or policy IDs come from HTTP/model output. */
interface AiServiceBase {
  backend: BackendClientConfig
  serviceToken: string
  audience?: string
  runtimeEncryptionKey: string
  budget: Budget
  sectionTimeoutMs: number
  policies: readonly ProviderPolicy[]
  /** Obtain fresh per-Run provider authorization from Backend before every actual transfer. */
  grant(session: ExecutionSession): Promise<ProviderGrant>
  recordMetric(metric: ProviderMetric, identity: Pick<ExecutionSession['receipt'], 'runId' | 'jobId' | 'executionAttempt'>): Promise<void>
  catalogs: readonly OfficialCatalog[]
  templates: readonly ReviewedTaskTemplate[]
  /** Select only reviewed configuration for this scope, or reject unsupported procedures. */
  researchScope(context: ContextArtifact): Promise<z.infer<typeof reviewedResearchScopeSchema>>
  maxSourceAgeMs: number
  sourceTimeoutMs: number
}

export type AiServiceComposition = AiServiceBase & (
  | { orca: { apiKey: string; timeoutMs?: number }; models?: never; orch?: never }
  | { orca?: never; models: Parameters<typeof createAuthorizedModels>[0]['models']; orch: OrchRouter }
)

/** Real storage/client/handlers/worker wiring. Missing external integrations are errors, never fixture fallbacks. */
export async function startConfiguredAiService(config: AiServiceComposition, listen: { port: number; hostname?: string; shutdownMs?: number }) {
  if (!config.serviceToken.trim() || (!config.orca && typeof config.orch?.route !== 'function') || typeof config.grant !== 'function' || typeof config.recordMetric !== 'function') throw new Error('Authenticated model/provider composition is required')
  const policies = z.array(providerPolicySchema).min(2).max(20).parse(config.policies)
  if (new Set(policies.map(p => p.id)).size !== policies.length || new Set(policies.map(p => p.sdkProvider)).size < 2 || new Set(policies.map(p => p.currency)).size !== 1) throw new Error('Distinct providers in one budget currency are required')
  const models = config.orca
    ? new Map(policies.map(policy => [policy.id, createOrcaModel({ ...config.orca!, modelId: policy.modelId })]))
    : config.models
  if (config.orca && ['core', 'research'].some(role => policies.filter(p => p.roles.includes(role as 'core' | 'research')).length > 2)) throw new Error('OrcaRouter allows at most two explicit policies per role')
  for (const policy of policies) {
    const model = models.get(policy.id)
    if (!model || model.specificationVersion !== 'v2' || model.provider !== policy.sdkProvider || model.modelId !== policy.modelId) throw new Error('Reviewed SDK model binding is missing')
    inferenceReservation(policy)
  }
  const catalogs = z.array(officialCatalogSchema).min(1).max(20).parse(config.catalogs)
  const research = createOfficialCatalogProvider(catalogs)
  const templates = z.array(reviewedTaskTemplateSchema).min(1).max(20).parse(config.templates)
  const sourceLimits = z.object({ age: z.number().int().positive().safe(), timeout: z.number().int().positive().max(10000) })
    .parse({ age: config.maxSourceAgeMs, timeout: config.sourceTimeoutMs })
  const limits = budgetSchema.parse(config.budget)
  const vault = new DispatchVault(config.runtimeEncryptionKey)
  for (const role of ['core', 'research'] as const) {
    const allowed = policies.filter(p => p.roles.includes(role) && p.dataClasses.includes(role === 'core' ? 'minimized_case' : 'public_research'))
    if (!allowed.length) throw new Error('Both agent roles require a reviewed provider policy')
  }
  const catalogIds = new Set(catalogs.map(catalog => catalog.id))
  if (templates.some(template => template.sourceCatalogIds.some(id => !catalogIds.has(id)))) throw new Error('Planning template references an unconfigured catalog')
  validateBackendClientConfig(config.backend)
  const db = createRuntimeFirestore()
  try {
    await db.collection('execution_runs').limit(1).get()
    const storage = createRuntimeStore(db), snapshots = new FirestoreWorkflowsStorage(db)
    const prepare = async (session: ExecutionSession) => {
      await session.guard()
      const scope = reviewedResearchScopeSchema.parse(await config.researchScope(session.context))
      if (scope.sourceCatalogIds.some(id => !catalogIds.has(id))) throw new Error('Research scope references an unconfigured catalog')
      const authorize = async (role: 'core' | 'research') => {
        const dataClass = role === 'core' ? 'minimized_case' as const : 'public_research' as const
        const options = { request: { requestId: randomUUID(), operation: session.receipt.operation, role, dataClass,
          policyIds: policies.filter(p => p.roles.includes(role) && p.dataClasses.includes(dataClass)).map(p => p.id) },
        policies, models, signal: session.signal,
        grant: async () => { await session.guard(); return config.grant(session) }, charge: session.guard,
        record: (metric: ProviderMetric) => config.recordMetric(metric, { runId: session.receipt.runId, jobId: session.receipt.jobId, executionAttempt: session.receipt.executionAttempt }) }
        return config.orca ? createAuthorizedOrcaModels(options) : createAuthorizedModels({ ...options, router: config.orch })
      }
      // Each physical gateway/provider attempt reserves its exact policy bound before sending data.
      const core = await authorize('core'), researchModel = await authorize('research')
      const reservation = (role: 'core' | 'research') => {
        const values = policies.filter(p => p.roles.includes(role)).map(inferenceReservation)
        return { tokens: Math.max(...values.map(v => v.tokens)), costMicros: Math.max(...values.map(v => v.costMicros)), maxOutputTokens: Math.max(...values.map(v => v.maxOutputTokens)) }
      }
      const budget: AgentBudget = { charge: session.guard, inferenceChargedByProviderAdapter: true, inference: { core: reservation('core'), research: reservation('research') } }
      return { models: { core: core.models, research: researchModel.models }, scope, catalogs, research, budget,
        maxSourceAgeMs: sourceLimits.age, timeoutMs: sourceLimits.timeout,
        beforeTool: async () => { await session.guard() }, evidenceId: core.evidenceId }
    }
    const runtime = new DurableExecutionRuntime({ store: new FirestoreExecutions(db, limits), snapshots, vault,
      client: dispatch => new BackendClient(config.backend, dispatch), sectionTimeoutMs: config.sectionTimeoutMs,
      handlers: {
        task_guidance: createGuidanceHandler({ storage, snapshots, prepare: async session => {
          const prepared = await prepare(session)
          return { ...prepared, authorizeRoute: async () => ({ routeId: 'procedure-guidance/v1' as const, evidenceId: prepared.evidenceId }) }
        } }),
        chat_reply: createChatHandler({ storage, prepare: async session => {
          const prepared = await prepare(session)
          return { ...prepared, authorizeRoute: async () => ({ routeId: 'chat-reply/v1' as const, evidenceId: prepared.evidenceId }) }
        } }),
        case_planning: createPlanningHandler({ storage, snapshots, templates, maxSourceAgeMs: sourceLimits.age, prepare: async session => {
          const prepared = await prepare(session)
          const selection = buildResearchBrief(buildPlanningContext(session.context), prepared.scope)
          if (selection.status !== 'ready') throw new Error('No reviewed planning research scope matches this Case')
          const tools = createResearchTools({ briefs: [selection.brief], catalogs, provider: research, signal: session.signal,
            maxSourceAgeMs: sourceLimits.age, timeoutMs: sourceLimits.timeout,
            beforeTool: kind => session.guard(kind === 'search' ? { searches: 1 } : { reads: 1 }) })
          return { routing: { routeId: 'case-planning/v1' as const, evidenceId: prepared.evidenceId },
            agents: { models: prepared.models, budget: prepared.budget, briefs: [selection.brief], researchTools: tools.tools,
              retrievedSourceIds: tools.retrievedSourceIds, signal: session.signal }, sources: () => tools.sources(selection.brief.briefId) }
        } }),
      } })
    const host = await startExecutionHost({ ...listen, runtime, worker: runtime, serviceToken: config.serviceToken,
      ...(config.audience ? { audience: config.audience } : {}) })
    let closing: Promise<boolean> | undefined, closedDb: Promise<void> | undefined
    const closeDb = () => closedDb ??= db.terminate()
    const done = host.done.then(closeDb)
    return { port: host.port, done,
      stop(): Promise<boolean> { return closing ??= host.stop().then(async graceful => { await closeDb(); return graceful }) },
    }
  } catch (error) { await db.terminate(); throw error }
}
