import { Hono } from 'hono'

// Process liveness only; business APIs and AI integrations are not implemented yet.
export const healthRoutes = new Hono().get('/health', (c) =>
  c.json({ data: { service: 'backend-server', status: 'ok' } }),
)
