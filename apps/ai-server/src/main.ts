import { startExecutionHost } from './infrastructure/execution/host.js'

const port = Number(process.env.PORT ?? 8081)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535')

// Real Orch/Provider/grant/catalog composition is required before injecting a runtime and worker.
const host = await startExecutionHost({ serviceToken: process.env.AI_SERVICE_TOKEN, audience: process.env.AI_SERVICE_AUDIENCE,
  hostname: process.env.HOST ?? '127.0.0.1', port })
console.log('ai-server listening on port', host.port)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void host.stop().then(graceful => process.exit(graceful ? 0 : 1)) })
}
