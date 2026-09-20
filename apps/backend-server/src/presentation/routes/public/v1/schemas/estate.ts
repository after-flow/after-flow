import type {
  ConfirmEstateItemRequest,
  CreateAssetRequest,
  CreateLiabilityRequest,
  UpdateAssetRequest,
  UpdateLiabilityRequest,
} from '@aftercare/public-contracts'
import { z, type ZodType } from 'zod'
import { YEN_MAX_EXCLUSIVE } from '../../../../../domain/estate/estate-item.js'
import { expectedVersion, longText, shortText } from './common.js'

/** 円単位の整数。null は「不明」で 0 円と区別する */
export const yenAmount = z.number().int().min(0).lt(YEN_MAX_EXCLUSIVE).nullable()

const assetKind = z.enum(['BANK', 'REAL_ESTATE', 'SECURITIES', 'CRYPTO', 'VEHICLE', 'OTHER'])
const liabilityKind = z.enum(['LOAN', 'CREDIT', 'TAX', 'GUARANTEE', 'OTHER'])

// source / confirmation / agentRunId 等はサーバーが決めるため、strict で受け付けない
export const createAssetSchema = z
  .object({
    name: shortText.min(1),
    kind: assetKind,
    institution: shortText.optional(),
    amount: yenAmount.optional(),
    taxAttention: z.boolean().optional(),
    note: longText.optional(),
  })
  .strict() satisfies ZodType<CreateAssetRequest>

export const updateAssetSchema = createAssetSchema
  .partial()
  .extend({ expectedVersion })
  .strict() satisfies ZodType<UpdateAssetRequest>

export const createLiabilitySchema = z
  .object({
    name: shortText.min(1),
    kind: liabilityKind,
    creditor: shortText.optional(),
    amount: yenAmount.optional(),
    note: longText.optional(),
  })
  .strict() satisfies ZodType<CreateLiabilityRequest>

export const updateLiabilitySchema = createLiabilitySchema
  .partial()
  .extend({ expectedVersion })
  .strict() satisfies ZodType<UpdateLiabilityRequest>

export const confirmEstateItemSchema = z
  .object({ expectedVersion, note: longText.optional() })
  .strict() satisfies ZodType<ConfirmEstateItemRequest>
