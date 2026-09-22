import { pathToFileURL } from 'node:url'
import { AccessService } from './application/authorization/case-access.js'
import { ConsentService } from './application/consent/consent-service.js'
import { OutboxDispatcher } from './application/agent/outbox-dispatcher.js'
import { acknowledgeLocally, caseTaskHandler, combineLocalHandlers, runOutboxWorker } from './application/agent/outbox-worker.js'
import { RunReconciler } from './application/agent/run-reconciler.js'
import { TaskService } from './application/task/task-service.js'
import { ProcedureSyncService } from './application/task/procedure-sync-service.js'
import { StoredInheritanceDecisionReader } from './application/decision/decision-service.js'
import { createFirestore, readFirestoreConfig } from './infrastructure/firestore/client.js'
import { FirestoreReadRepository } from './infrastructure/firestore/read-repository.js'
import { FirestoreUnitOfWork } from './infrastructure/firestore/unit-of-work.js'
import { ContextVersionUnitOfWork } from './application/case/context-version-unit-of-work.js'
import { assertValidId } from './infrastructure/firestore/paths.js'
import { readConsentCatalog } from './infrastructure/consent/catalog-config.js'
import { readRuleCatalog } from './infrastructure/rules/rule-config.js'
import { readAgentClientConfig } from './infrastructure/agent/http-agent-client.js'
import { ScopedHttpAgentJobClient } from './infrastructure/agent/scoped-http-agent-client.js'
import { readExecutionAuthorization } from './infrastructure/identity/execution-authorization.js'
import { InternalExecutionService } from './application/agent/internal-execution-service.js'
import { AgentResultIntake } from './application/chat/result-intake.js'
import type { AgentJobClient } from './application/ports/agent-client.js'

export async function startWorker(env: NodeJS.ProcessEnv = process.env, once = false): Promise<void> {
  const tenantIds = [...new Set((env.OUTBOX_TENANT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean))]
  if (!tenantIds.length) throw new Error('OUTBOX_TENANT_IDS is required; no implicit global scan')
  for (const id of tenantIds) assertValidId(id, 'tenantId')
  const intervalMs = Number(env.OUTBOX_INTERVAL_MS || 5_000)
  const visibilityMs = Number(env.OUTBOX_VISIBILITY_MS || 120_000)
  const deliveryTimeoutMs = Number(env.OUTBOX_DELIVERY_TIMEOUT_MS || 15 * 60_000)
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs <= visibilityMs || deliveryTimeoutMs > 24 * 3_600_000) {
    throw new Error('OUTBOX_DELIVERY_TIMEOUT_MS must exceed OUTBOX_VISIBILITY_MS and stay within 24 hours')
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error('Invalid OUTBOX_INTERVAL_MS')
  const config = readAgentClientConfig(env)
  if (!Number.isInteger(visibilityMs) || visibilityMs < 1000 || visibilityMs > 3_600_000
    || (config && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs >= visibilityMs))) {
    throw new Error('OUTBOX_VISIBILITY_MS must exceed the finite AI HTTP timeout')
  }
  const db = createFirestore(readFirestoreConfig(env))
  const read = new FirestoreReadRepository(db)
  const uow = new ContextVersionUnitOfWork(new FirestoreUnitOfWork(db))
  const access = new AccessService(read)
  const consent = new ConsentService(readConsentCatalog(env), access, read, uow)
  const ruleCatalog = readRuleCatalog(env)
  const procedureSync = new ProcedureSyncService(ruleCatalog, read)
  const tasks = new TaskService(ruleCatalog, access, read, uow, procedureSync, new StoredInheritanceDecisionReader(read))
  const unavailable: AgentJobClient = { deliver: async () => ({ status: 'RETRYABLE', reason: 'AI_NOT_CONNECTED' }) }
  const authorization = readExecutionAuthorization(env)
  const execution = new InternalExecutionService(read, uow, consent, new AgentResultIntake(read, uow), undefined,
    { rejectDraftDefinitions: env.NODE_ENV === 'production' })
  const scopedClient = config && authorization ? new ScopedHttpAgentJobClient(config, execution, authorization) : null
  const client = scopedClient ?? unavailable
  const reconciler = new RunReconciler(read, uow, execution, scopedClient ?? { status: async () => { throw new Error('AI_NOT_CONNECTED') } })
  const local = combineLocalHandlers(caseTaskHandler(tasks), reconciler, acknowledgeLocally(['task.completed', 'decision.confirmed']))
  const dispatcher = new OutboxDispatcher(db, client, consent, visibilityMs, local, {
    deliveryTimeoutMs,
    onGiveUp: async (event, reason) => {
      if (!event.type.startsWith('agent.') || event.type === 'agent.cancel' || !event.caseId || typeof event.payload.runId !== 'string') return
      await execution.abandonDispatch(event.tenantId, event.caseId, event.payload.runId, event.id, reason)
    },
  })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try { await runOutboxWorker(dispatcher, { tenantIds, intervalMs, signal: controller.signal, once, reconciler }) }
  finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    await db.terminate()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startWorker(process.env, process.argv.includes('--once'))
}
