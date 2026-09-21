import { randomBytes } from 'node:crypto'
import { startExecutionHost } from '../../src/infrastructure/execution/host.js'
import { DurableExecutionRuntime } from '../../src/infrastructure/execution/runtime.js'
import { createChatHandler } from '../../src/infrastructure/execution/handlers.js'
import { BackendClient } from '../../src/infrastructure/backend-client/client.js'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { createRuntimeStore, FirestoreWorkflowsStorage } from '../../src/infrastructure/runtime-storage/workflows.js'
import { FirestoreExecutions } from '../../src/infrastructure/runtime-storage/executions.js'
import { DispatchVault } from '../../src/infrastructure/runtime-storage/credential-vault.js'
import { scriptedModel } from './scripted-model.js'

// Test-only process. No Backend DB/signing/original Storage credentials enter this process.
if (process.env.AI_HTTP_FIXTURE !== 'synthetic-only') throw new Error('Fixture must be explicitly selected')
const db = createRuntimeFirestore(); const storage = createRuntimeStore(db)
const store = new FirestoreExecutions(db, { tools: 20, research: 2, searches: 6, reads: 12, inferenceAttempts: 24, replans: 2, tokens: 50000, costMicros: 100000, activeMs: 60000 })
const runtime = new DurableExecutionRuntime({ store, snapshots: new FirestoreWorkflowsStorage(db), vault: new DispatchVault(randomBytes(32).toString('base64')), sectionTimeoutMs: 30000,
  client: dispatch => new BackendClient({ baseUrl: process.env.AI_TEST_BACKEND_ORIGIN!, serviceToken: process.env.AI_TEST_BACKEND_TOKEN!,
    allowInsecureHttp: true, insecureHttpAllowedHosts: ['127.0.0.1'] }, dispatch),
  handlers: { chat_reply: createChatHandler({ storage, prepare: async session => ({
    models: { core: scriptedModel([{ text: JSON.stringify({ paragraphs: [], questions: ['対象の手続きを教えていただけますか？'], professionalNotice: false }) }]).model,
      research: scriptedModel([]).model },
    budget: { charge: session.guard, inference: { core: { tokens: 10000, costMicros: 10000, maxOutputTokens: 1000 }, research: { tokens: 10000, costMicros: 10000, maxOutputTokens: 1000 } } },
    authorizeRoute: async () => ({ routeId: 'chat-reply/v1', evidenceId: 'synthetic-orch-only' }),
    scope: { id: 'brief', version: '1', reviewedAt: '2026-09-01T00:00:00Z', procedure: '架空手続き', institution: '架空機関', jurisdiction: '架空地域', municipality: null,
      procedureIds: ['fixture-procedure'], sourceCatalogIds: ['catalog'], sourceCatalogVersions: { catalog: '1' }, questions: [{ id: 'where', text: '提出先を確認する' }] },
    catalogs: [{ id: 'catalog', allowedHosts: ['official.example'] }], timeoutMs: 1000, maxSourceAgeMs: 60000, beforeTool: () => session.guard(),
    research: { search: async () => { throw new Error('Unexpected fixture search') }, read: async () => { throw new Error('Unexpected fixture retrieval') } },
  }) }) },
})
const host = await startExecutionHost({ port: 0, runtime, worker: runtime, serviceToken: process.env.AI_TEST_INGRESS_TOKEN })
console.log(JSON.stringify({ type: 'ready', port: host.port }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void (async () => {
  const graceful = await host.stop(); await db.terminate(); process.exit(graceful ? 0 : 1)
})() })
