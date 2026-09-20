import { z } from 'zod'
import type { ContractService } from '../../../../application/contracts/contract-service.js'
import { ok } from '../../../http/envelope.js'
import { defineRoute, type RegisteredRoute, type RouteSpec } from '../../../http/route.js'
import { idSchema, successEnvelope } from '../../../schemas/common.js'
import { businessListQuerySchema, contractResourceSchema, benefitResourceSchema } from '../../../schemas/business.js'
import { businessContext } from './business-context.js'
import { createContractSchema, updateContractSchema, setContractPolicySchema, reportProgressSchema, createBenefitSchema, updateBenefitSchema } from './schemas/contracts.js'

export const contractsSpecs = {
  listContracts: {
    operationId: 'listContracts', method: 'get', path: '/cases/:caseId/contracts',
    summary: 'listContracts', tags: ['contracts'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Contract', schema: successEnvelope(z.array(contractResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createContract: {
    operationId: 'createContract', method: 'post', path: '/cases/:caseId/contracts',
    summary: 'createContract', tags: ['contracts'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createContractSchema },
    success: { status: 201, description: 'Contract', schema: successEnvelope(contractResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updateContract: {
    operationId: 'updateContract', method: 'patch', path: '/cases/:caseId/contracts/:contractId',
    summary: 'updateContract', tags: ['contracts'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, contractId: idSchema }), body: updateContractSchema },
    success: { status: 200, description: 'Contract', schema: successEnvelope(contractResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  setContractPolicy: {
    operationId: 'setContractPolicy', method: 'post', path: '/cases/:caseId/contracts/:contractId/policy',
    summary: 'setContractPolicy', tags: ['contracts'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, contractId: idSchema }), body: setContractPolicySchema },
    success: { status: 200, description: 'Contract', schema: successEnvelope(contractResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  reportContractProgress: {
    operationId: 'reportContractProgress', method: 'post', path: '/cases/:caseId/contracts/:contractId/progress',
    summary: 'reportContractProgress', tags: ['contracts'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, contractId: idSchema }), body: reportProgressSchema },
    success: { status: 200, description: 'Contract', schema: successEnvelope(contractResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  listBenefits: {
    operationId: 'listBenefits', method: 'get', path: '/cases/:caseId/benefits',
    summary: 'listBenefits', tags: ['benefits'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), query: businessListQuerySchema },
    success: { status: 200, description: 'Benefit', schema: successEnvelope(z.array(benefitResourceSchema)) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'],
    list: true,
  },
  createBenefit: {
    operationId: 'createBenefit', method: 'post', path: '/cases/:caseId/benefits',
    summary: 'createBenefit', tags: ['benefits'], auth: 'user',
    request: { params: z.object({ caseId: idSchema }), body: createBenefitSchema },
    success: { status: 201, description: 'Benefit', schema: successEnvelope(benefitResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  updateBenefit: {
    operationId: 'updateBenefit', method: 'patch', path: '/cases/:caseId/benefits/:benefitId',
    summary: 'updateBenefit', tags: ['benefits'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, benefitId: idSchema }), body: updateBenefitSchema },
    success: { status: 200, description: 'Benefit', schema: successEnvelope(benefitResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
  reportBenefitProgress: {
    operationId: 'reportBenefitProgress', method: 'post', path: '/cases/:caseId/benefits/:benefitId/progress',
    summary: 'reportBenefitProgress', tags: ['benefits'], auth: 'user',
    request: { params: z.object({ caseId: idSchema, benefitId: idSchema }), body: reportProgressSchema },
    success: { status: 200, description: 'Benefit', schema: successEnvelope(benefitResourceSchema) },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required', expectedVersion: 'required',
  },
} satisfies Record<string, RouteSpec>

export function createContractRoutes(service: ContractService): RegisteredRoute[] {
  return [
    defineRoute(contractsSpecs.listContracts, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listContracts(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(contractsSpecs.createContract, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createContract(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(contractsSpecs.updateContract, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updateContract(ctx, input.params.contractId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(contractsSpecs.setContractPolicy, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.setContractPolicy(ctx, input.params.contractId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(contractsSpecs.reportContractProgress, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.reportContractProgress(ctx, input.params.contractId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(contractsSpecs.listBenefits, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const page = await service.listBenefits(ctx, { ...input.query, cursor: input.query.cursor ?? null })
      return ok(c, page.items, page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }),
    defineRoute(contractsSpecs.createBenefit, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.createBenefit(ctx, input.body)
      return ok(c, result.body, { status: 201 })
    }),
    defineRoute(contractsSpecs.updateBenefit, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.updateBenefit(ctx, input.params.benefitId, input.body)
      return ok(c, result.body)
    }),
    defineRoute(contractsSpecs.reportBenefitProgress, async (c, input) => {
      const ctx = businessContext(c, input.params.caseId, input.idempotencyKey)
      const result = await service.reportBenefitProgress(ctx, input.params.benefitId, input.body)
      return ok(c, result.body)
    }),
  ]
}
