import { Hono } from 'hono'

/** Liveness stays independent from model/runtime readiness. */
export const healthRoutes = (executionConnected: boolean) => new Hono()
  .get('/health', c => c.json({ data: { service: 'ai-server', status: 'ok' } }))
  .get('/ready', c => executionConnected
    ? c.json({ data: { service: 'ai-server', status: 'ready', execution: 'connected' } })
    : c.json({ error: { code: 'AI_EXECUTION_NOT_CONNECTED' } }, 503))
