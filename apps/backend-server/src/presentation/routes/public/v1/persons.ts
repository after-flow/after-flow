import { Hono } from 'hono'
import type { PersonService } from '../../../../application/persons/person-service.js'
import { ok, okPage, requestIdOf } from '../../../http/envelope.js'
import type { AppBindings } from '../../../http/types.js'
import { commandContext, parseBody, parseListQuery } from '../../../http/request.js'
import { excludeRequestSchema } from './schemas/common.js'
import {
  createPersonSchema,
  createRelationshipSchema,
  updatePersonSchema,
  updateRelationshipSchema,
} from './schemas/persons.js'

/** /cases/:caseId 配下にマウントする。認証ミドルウェアは呼び出し側で適用済みであること */
export function personRoutes(service: PersonService) {
  const app = new Hono<AppBindings>()

  app.get('/persons', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listPersons(ctx, parseListQuery(c)))
  })

  app.post('/persons', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, createPersonSchema)
    const result = await service.createPerson(ctx, body)
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })

  app.patch('/persons/:personId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, updatePersonSchema)
    const result = await service.updatePerson(ctx, c.req.param('personId'), body)
    return ok(c, result.body)
  })

  app.post('/persons/:personId/exclude', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, excludeRequestSchema)
    const result = await service.excludePerson(ctx, c.req.param('personId'), body)
    return ok(c, result.body)
  })

  app.get('/relationships', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), false)
    return okPage(c, await service.listRelationships(ctx, parseListQuery(c)))
  })

  app.post('/relationships', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, createRelationshipSchema)
    const result = await service.createRelationship(ctx, body)
    return ok(c, result.body, result.statusCode === 201 ? 201 : 200)
  })

  app.patch('/relationships/:relationshipId', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, updateRelationshipSchema)
    const result = await service.updateRelationship(ctx, c.req.param('relationshipId'), body)
    return ok(c, result.body)
  })

  app.post('/relationships/:relationshipId/exclude', async (c) => {
    const ctx = commandContext(c, requestIdOf(c), true)
    const body = await parseBody(c, excludeRequestSchema)
    const result = await service.excludeRelationship(ctx, c.req.param('relationshipId'), body)
    return ok(c, result.body)
  })

  return app
}
