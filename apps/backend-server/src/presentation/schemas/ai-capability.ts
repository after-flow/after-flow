import { z } from 'zod'

/** `AiFeatureCapabilityResource` と同じ状態しか表現できないようにする。 */
export const aiFeatureCapabilityResourceSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), reason: z.null() }),
  z.object({ available: z.literal(false), reason: z.literal('FEATURE_NOT_CONNECTED') }),
])

export const aiCapabilitiesResourceSchema = z.object({
  features: z.object({
    task_guidance: aiFeatureCapabilityResourceSchema,
    ai_chat: aiFeatureCapabilityResourceSchema,
  }),
})
