import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { createContainer, type Container } from './composition.js'
import { fail, handleError, REQUEST_ID_KEY } from './presentation/http/envelope.js'
import type { AppBindings } from './presentation/http/types.js'
import { requireAuth } from './presentation/middleware/auth.js'
import { contractRoutes } from './presentation/routes/public/v1/contracts.js'
import { estateRoutes } from './presentation/routes/public/v1/estate.js'
import { healthRoutes } from './presentation/routes/public/v1/health.js'
import { insightRoutes } from './presentation/routes/public/v1/insights.js'
import { personRoutes } from './presentation/routes/public/v1/persons.js'

export function createApp(container: Container = createContainer()) {
  const app = new Hono<AppBindings>()

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID()
    c.set(REQUEST_ID_KEY, requestId)
    c.header('x-request-id', requestId)
    await next()
  })
  app.onError(handleError)
  app.notFound((c) => fail(c, 404, 'NOT_FOUND', 'エンドポイントが見つかりません'))

  app.route('/api/v1', healthRoutes)

  const caseScoped = new Hono<AppBindings>()
  caseScoped.use('*', requireAuth(container.identity))
  caseScoped.route('/', personRoutes(container.personService))
  caseScoped.route('/', estateRoutes(container.estateService))
  caseScoped.route('/', contractRoutes(container.contractService))
  caseScoped.route('/', insightRoutes(container.insightService))
  app.route('/api/v1/cases/:caseId', caseScoped)

  return app
}
