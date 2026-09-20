import { z } from 'zod'
import type { EstateService } from '../../../../application/estate/estate-service.js'
import { ok } from '../../../http/envelope.js'
import { defineRoute, type RegisteredRoute, type RouteSpec } from '../../../http/route.js'
import { idSchema, successEnvelope } from '../../../schemas/common.js'
import { businessListQuerySchema, assetResourceSchema, liabilityResourceSchema } from '../../../schemas/business.js'
import { businessContext } from './business-context.js'
import { createAssetSchema, updateAssetSchema, confirmEstateItemSchema, createLiabilitySchema, updateLiabilitySchema } from './schemas/estate.js'

export const estateSpecs = {
  listAssets: {
    operationId: 'listAssets', method: 'get', path: '/cases/:caseId/assets',
    summary: 'listAssets', tags: ['assets'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Asset', schema: successEnvelope(z.array(assetResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createAsset: {
    operationId: 'createAsset', method: 'post', path: '/cases/:caseId/assets',
    summary: 'createAsset', tags: ['assets'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createAssetSchema },
    success: { status: 201, description: 'Asset', schema: successEnvelope(assetResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updateAsset: {
    operationId: 'updateAsset', method: 'patch', path: '/cases/:caseId/assets/:assetId',
    summary: 'updateAsset', tags: ['assets'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, assetId: idSchema }), body: updateAssetSchema },
    success: { status: 200, description: 'Asset', schema: successEnvelope(assetResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  confirmAsset: {
    operationId: 'confirmAsset', method: 'post', path: '/cases/:caseId/assets/:assetId/confirm',
    summary: 'confirmAsset', tags: ['assets'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, assetId: idSchema }), body: confirmEstateItemSchema },
    success: { status: 200, description: 'Asset', schema: successEnvelope(assetResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  listLiabilities: {
    operationId: 'listLiabilities', method: 'get', path: '/cases/:caseId/liabilities',
    summary: 'listLiabilities', tags: ['liabilities'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Liability', schema: successEnvelope(z.array(liabilityResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createLiability: {
    operationId: 'createLiability', method: 'post', path: '/cases/:caseId/liabilities',
    summary: 'createLiability', tags: ['liabilities'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createLiabilitySchema },
    success: { status: 201, description: 'Liability', schema: successEnvelope(liabilityResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updateLiability: {
    operationId: 'updateLiability', method: 'patch', path: '/cases/:caseId/liabilities/:liabilityId',
    summary: 'updateLiability', tags: ['liabilities'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, liabilityId: idSchema }), body: updateLiabilitySchema },
    success: { status: 200, description: 'Liability', schema: successEnvelope(liabilityResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  confirmLiability: {
    operationId: 'confirmLiability', method: 'post', path: '/cases/:caseId/liabilities/:liabilityId/confirm',
    summary: 'confirmLiability', tags: ['liabilities'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, liabilityId: idSchema }), body: confirmEstateItemSchema },
    success: { status: 200, description: 'Liability', schema: successEnvelope(liabilityResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
} satisfies Record<string, RouteSpec>

export function createEstateRoutes(service: EstateService): RegisteredRoute[] {
  return [
    defineRoute(estateSpecs.listAssets, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listAssets(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(estateSpecs.createAsset, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createAsset(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(estateSpecs.updateAsset, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updateAsset(ctx, input.params.assetId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(estateSpecs.confirmAsset, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.confirmAsset(ctx, input.params.assetId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(estateSpecs.listLiabilities, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listLiabilities(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(estateSpecs.createLiability, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createLiability(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(estateSpecs.updateLiability, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updateLiability(ctx, input.params.liabilityId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(estateSpecs.confirmLiability, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.confirmLiability(ctx, input.params.liabilityId, input.body)
      return ok(c, result.body)
    }),
  ]
}
