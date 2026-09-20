import { Hono } from 'hono'
import { healthRoutes } from './presentation/routes/internal/v1/health.js'

export function createApp() {
  const app = new Hono()
  app.route('/internal/v1', healthRoutes)
  return app
}
