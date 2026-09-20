import { Hono } from 'hono'
import type { EstateService } from '../../../../application/estate/estate-service.js'
import { ok, okPage, requestIdOf } from '../../../http/envelope.js'
import { commandContext, parseBody, parseListQuery } from '../../../http/request.js'
import type { AppBindings } from '../../../http/types.js'
import {
  confirmEstateItemSchema,
  createAssetSchema,
  createLiabilitySchema,
  updateAssetSchema,
  updateLiabilitySchema,
} from './schemas/estate.js'

/** /cases/:caseId 配下にマウントする。確認は PATCH ではなく明示的な confirm Command */
export function estateRoutes(service: EstateService) {
  const app = new Hono<AppBindings>()

  app.get('/assets', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listAssets(ctx, parseListQuery(c)))
  })
  app.post('/assets', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.createAsset(ctx, await parseBody(c, createAssetSchema))
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })
  app.patch('/assets/:assetId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.updateAsset(ctx, c.req.param('assetId'), await parseBody(c, updateAssetSchema))
    return ok(c, result.body)
  })
  app.post('/assets/:assetId/confirm', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.confirmAsset(ctx, c.req.param('assetId'), await parseBody(c, confirmEstateItemSchema))
    return ok(c, result.body)
  })

  app.get('/liabilities', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listLiabilities(ctx, parseListQuery(c)))
  })
  app.post('/liabilities', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.createLiability(ctx, await parseBody(c, createLiabilitySchema))
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })
  app.patch('/liabilities/:liabilityId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.updateLiability(
      ctx,
      c.req.param('liabilityId'),
      await parseBody(c, updateLiabilitySchema),
    )
    return ok(c, result.body)
  })
  app.post('/liabilities/:liabilityId/confirm', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.confirmLiability(
      ctx,
      c.req.param('liabilityId'),
      await parseBody(c, confirmEstateItemSchema),
    )
    return ok(c, result.body)
  })

  return app
}
