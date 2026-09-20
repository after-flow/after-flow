import type { AcknowledgeInsightRequest, DismissInsightRequest } from '@aftercare/public-contracts'
import { Hono } from 'hono'
import { z, type ZodType } from 'zod'
import type { InsightService } from '../../../../application/insights/insight-service.js'
import { ok, okPage, requestIdOf } from '../../../http/envelope.js'
import { commandContext, parseBody, parseListQuery } from '../../../http/request.js'
import type { AppBindings } from '../../../http/types.js'
import { longText } from './schemas/common.js'

const acknowledgeSchema = z.object({ note: longText.optional() }).strict() satisfies ZodType<AcknowledgeInsightRequest>
const dismissSchema = z.object({ reason: longText.optional() }).strict() satisfies ZodType<DismissInsightRequest>

/**
 * /cases/:caseId 配下。気づきの登録は内部結果（#10）経由のみで、公開APIには POST/PATCH を置かない。
 * 既読・非表示は閲覧者ごとの Command。
 */
export function insightRoutes(service: InsightService) {
  const app = new Hono<AppBindings>()

  app.get('/insights', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listInsights(ctx, parseListQuery(c)))
  })
  app.post('/insights/:insightId/acknowledge', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.acknowledge(ctx, c.req.param('insightId'), await parseBody(c, acknowledgeSchema))
    return ok(c, result.body)
  })
  app.post('/insights/:insightId/dismiss', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.dismiss(ctx, c.req.param('insightId'), await parseBody(c, dismissSchema))
    return ok(c, result.body)
  })

  return app
}
