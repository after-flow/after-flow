import { serve } from '@hono/node-server'
import { createServer } from './composition.js'

const port = Number(process.env.PORT ?? 8080)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const app = createServer()

const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? '127.0.0.1',
  port,
}, (info) => {
  console.log('backend-server listening on port', info.port)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => {
      process.exit(error ? 1 : 0)
    })
  })
}
