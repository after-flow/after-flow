import { Hono } from 'hono'
import { healthRoutes } from './presentation/routes/public/v1/health.js'

export function createApp() {
  const app = new Hono()
  app.route('/api/v1', healthRoutes)
  return app
}
