import { z } from 'zod'
import { internalId, operationSchema } from '@aftercare/internal-contracts'

export const dataClassSchema = z.enum(['minimized_case', 'public_research'])
export const providerPolicySchema = z.object({
  id: internalId, revision: internalId, sdkProvider: z.string().min(1).max(100), modelId: z.string().min(1).max(200),
  roles: z.array(z.enum(['core', 'research'])).min(1).max(2), dataClasses: z.array(dataClassSchema).min(1).max(2),
  approvedAt: z.string().datetime(), expiresAt: z.string().datetime(), reviewReference: z.string().min(1).max(500),
  trainingUse: z.literal(false), retentionDays: z.number().int().nonnegative().max(365),
  capabilities: z.object({ tools: z.literal(true), structuredOutput: z.literal(true), japanese: z.literal(true) }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/), maxInputTokens: z.number().int().positive().max(2000000),
  maxOutputTokens: z.number().int().positive().max(200000),
  inputMicrosPerToken: z.number().nonnegative().finite(), outputMicrosPerToken: z.number().nonnegative().finite(),
}).strict()
export type ProviderPolicy = z.infer<typeof providerPolicySchema>
export const providerGrantSchema = z.object({
  revision: internalId, providerPolicyIds: z.array(internalId).min(1).max(20), dataClasses: z.array(dataClassSchema).min(1).max(2),
  expiresAt: z.string().datetime(), maxRetentionDays: z.number().int().nonnegative(),
}).strict()
export type ProviderGrant = z.infer<typeof providerGrantSchema>
export const routeRequestSchema = z.object({
  requestId: internalId, operation: operationSchema, role: z.enum(['core', 'research']),
  dataClass: dataClassSchema, policyIds: z.array(internalId).min(1).max(20),
}).strict()
export type RouteRequest = z.infer<typeof routeRequestSchema>
export const routeDecisionSchema = z.object({
  requestId: internalId, evidenceId: internalId, policyIds: z.array(internalId).min(1).max(2), expiresAt: z.string().datetime(),
}).strict()
export type RouteDecision = z.infer<typeof routeDecisionSchema>

/** Host must obtain the decision from the verified hackathon OrchRouter adapter. No default switch/router. */
export interface OrchRouter {
  route(request: RouteRequest, signal: AbortSignal): Promise<RouteDecision>
}
export function assertProviderAllowed(policy: ProviderPolicy, grant: ProviderGrant, role: RouteRequest['role'], dataClass: RouteRequest['dataClass'], now = Date.now()) {
  providerPolicySchema.parse(policy); providerGrantSchema.parse(grant)
  if (Date.parse(policy.approvedAt) > now || Date.parse(policy.expiresAt) <= now || Date.parse(grant.expiresAt) <= now ||
    !grant.providerPolicyIds.includes(policy.id) || !grant.dataClasses.includes(dataClass) || !policy.roles.includes(role) ||
    !policy.dataClasses.includes(dataClass) || policy.retentionDays > grant.maxRetentionDays) throw new Error('Provider policy does not authorize this transfer')
}
export function inferenceReservation(policy: ProviderPolicy) {
  const tokens = policy.maxInputTokens + policy.maxOutputTokens
  const costMicros = Math.ceil(policy.maxInputTokens * policy.inputMicrosPerToken + policy.maxOutputTokens * policy.outputMicrosPerToken)
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(costMicros) || costMicros <= 0) throw new Error('A finite priced model bound is required')
  return { tokens, costMicros, maxOutputTokens: policy.maxOutputTokens }
}
