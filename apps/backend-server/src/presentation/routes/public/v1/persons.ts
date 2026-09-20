import { z } from 'zod'
import type { PersonService } from '../../../../application/persons/person-service.js'
import { ok } from '../../../http/envelope.js'
import { defineRoute, type RegisteredRoute, type RouteSpec } from '../../../http/route.js'
import { idSchema, successEnvelope } from '../../../schemas/common.js'
import { businessListQuerySchema, personResourceSchema, relationshipResourceSchema } from '../../../schemas/business.js'
import { businessContext } from './business-context.js'
import { createPersonSchema, updatePersonSchema, createRelationshipSchema, updateRelationshipSchema } from './schemas/persons.js'
import { excludeRequestSchema } from './schemas/common.js'

export const personsSpecs = {
  listPersons: {
    operationId: 'listPersons', method: 'get', path: '/cases/:caseId/persons',
    summary: 'listPersons', tags: ['persons'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Person', schema: successEnvelope(z.array(personResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createPerson: {
    operationId: 'createPerson', method: 'post', path: '/cases/:caseId/persons',
    summary: 'createPerson', tags: ['persons'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createPersonSchema },
    success: { status: 201, description: 'Person', schema: successEnvelope(personResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updatePerson: {
    operationId: 'updatePerson', method: 'patch', path: '/cases/:caseId/persons/:personId',
    summary: 'updatePerson', tags: ['persons'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, personId: idSchema }), body: updatePersonSchema },
    success: { status: 200, description: 'Person', schema: successEnvelope(personResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  excludePerson: {
    operationId: 'excludePerson', method: 'post', path: '/cases/:caseId/persons/:personId/exclude',
    summary: 'excludePerson', tags: ['persons'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, personId: idSchema }), body: excludeRequestSchema },
    success: { status: 200, description: 'Person', schema: successEnvelope(personResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  listRelationships: {
    operationId: 'listRelationships', method: 'get', path: '/cases/:caseId/relationships',
    summary: 'listRelationships', tags: ['relationships'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Relationship', schema: successEnvelope(z.array(relationshipResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createRelationship: {
    operationId: 'createRelationship', method: 'post', path: '/cases/:caseId/relationships',
    summary: 'createRelationship', tags: ['relationships'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createRelationshipSchema },
    success: { status: 201, description: 'Relationship', schema: successEnvelope(relationshipResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updateRelationship: {
    operationId: 'updateRelationship', method: 'patch', path: '/cases/:caseId/relationships/:relationshipId',
    summary: 'updateRelationship', tags: ['relationships'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, relationshipId: idSchema }), body: updateRelationshipSchema },
    success: { status: 200, description: 'Relationship', schema: successEnvelope(relationshipResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  excludeRelationship: {
    operationId: 'excludeRelationship', method: 'post', path: '/cases/:caseId/relationships/:relationshipId/exclude',
    summary: 'excludeRelationship', tags: ['relationships'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, relationshipId: idSchema }), body: excludeRequestSchema },
    success: { status: 200, description: 'Relationship', schema: successEnvelope(relationshipResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
} satisfies Record<string, RouteSpec>

export function createPersonRoutes(service: PersonService): RegisteredRoute[] {
  return [
    defineRoute(personsSpecs.listPersons, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listPersons(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(personsSpecs.createPerson, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createPerson(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(personsSpecs.updatePerson, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updatePerson(ctx, input.params.personId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(personsSpecs.excludePerson, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.excludePerson(ctx, input.params.personId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(personsSpecs.listRelationships, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listRelationships(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(personsSpecs.createRelationship, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createRelationship(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(personsSpecs.updateRelationship, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updateRelationship(ctx, input.params.relationshipId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(personsSpecs.excludeRelationship, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.excludeRelationship(ctx, input.params.relationshipId, input.body)
      return ok(c, result.body)
    }),
  ]
}
