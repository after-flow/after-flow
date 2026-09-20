import { Hono } from 'hono'
import type { ContractService } from '../../../../application/contracts/contract-service.js'
import { ok, okPage, requestIdOf } from '../../../http/envelope.js'
import { commandContext, parseBody, parseListQuery } from '../../../http/request.js'
import type { AppBindings } from '../../../http/types.js'
import {
  createBenefitSchema,
  createContractSchema,
  reportProgressSchema,
  setContractPolicySchema,
  updateBenefitSchema,
  updateContractSchema,
} from './schemas/contracts.js'

/** /cases/:caseId 配下。方針・進捗は PATCH ではなく policy / progress Command で変更する */
export function contractRoutes(service: ContractService) {
  const app = new Hono<AppBindings>()

  app.get('/contracts', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listContracts(ctx, parseListQuery(c)))
  })
  app.post('/contracts', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.createContract(ctx, await parseBody(c, createContractSchema))
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })
  app.patch('/contracts/:contractId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.updateContract(
      ctx,
      c.req.param('contractId'),
      await parseBody(c, updateContractSchema),
    )
    return ok(c, result.body)
  })
  app.post('/contracts/:contractId/policy', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.setContractPolicy(
      ctx,
      c.req.param('contractId'),
      await parseBody(c, setContractPolicySchema),
    )
    return ok(c, result.body)
  })
  app.post('/contracts/:contractId/progress', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.reportContractProgress(
      ctx,
      c.req.param('contractId'),
      await parseBody(c, reportProgressSchema),
    )
    return ok(c, result.body)
  })

  app.get('/benefits', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listBenefits(ctx, parseListQuery(c)))
  })
  app.post('/benefits', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.createBenefit(ctx, await parseBody(c, createBenefitSchema))
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })
  app.patch('/benefits/:benefitId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.updateBenefit(ctx, c.req.param('benefitId'), await parseBody(c, updateBenefitSchema))
    return ok(c, result.body)
  })
  app.post('/benefits/:benefitId/progress', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const result = await service.reportBenefitProgress(
      ctx,
      c.req.param('benefitId'),
      await parseBody(c, reportProgressSchema),
    )
    return ok(c, result.body)
  })

  return app
}
