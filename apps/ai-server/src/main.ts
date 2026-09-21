import { startExecutionHost } from './infrastructure/execution/host.js'
import { startConfiguredAiService } from './infrastructure/execution/composition.js'
import { readHackathonComposition } from './infrastructure/execution/hackathon-config.js'

const port = Number(process.env.PORT ?? 8081)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535')

const config = readHackathonComposition(process.env)
const listen = { hostname: process.env.HOST ?? '127.0.0.1', port }
const host = config
  ? await startConfiguredAiService(config, listen)
  : await startExecutionHost({ serviceToken: process.env.AI_SERVICE_TOKEN, audience: process.env.AI_SERVICE_AUDIENCE, ...listen })
console.log(`ai-server listening on port ${host.port}; execution=${config ? 'connected' : 'disabled'}`)
let stopping = false
void host.done.then(() => {
  if (!stopping) {
    console.error('ai-server worker stopped unexpectedly')
    process.exitCode = 1
  }
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true
    void host.stop().then(graceful => process.exit(graceful ? 0 : 1))
  })
}
