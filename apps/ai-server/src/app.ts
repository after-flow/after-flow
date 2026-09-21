import { Hono } from 'hono'
import { healthRoutes } from './presentation/routes/internal/v1/health.js'
import { executionRoutes } from './presentation/routes/internal/v1/execution.js'
import type { ExecutionOptions } from './presentation/routes/internal/v1/execution.js'

export function createApp(options: ExecutionOptions = {}) {
  const app = new Hono()
  app.route('/internal/v1', healthRoutes(Boolean(options.runtime)))
  app.route('/internal/v1', executionRoutes(options))
  return app
}
