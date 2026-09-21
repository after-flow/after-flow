import type {
  CreateBenefitRequest,
  CreateContractRequest,
  ReportProgressRequest,
  SetContractPolicyRequest,
  UpdateBenefitRequest,
  UpdateContractRequest,
} from '@aftercare/public-contracts'
import { z, type ZodType } from 'zod'
import { expectedVersion, longText, shortText } from './common.js'
import { yenAmount } from './estate.js'

const contractKind = z.enum(['UTILITY', 'TELECOM', 'SUBSCRIPTION', 'INSURANCE', 'PENSION', 'OTHER'])
const benefitKind = z.enum(['INSURANCE_PAYOUT', 'PENSION', 'LUMP_SUM', 'OTHER'])
const contractPolicy = z.enum(['UNDECIDED', 'CONTINUE', 'TRANSFER', 'CANCEL'])
const contractProgress = z.enum(['NOT_STARTED', 'CONTACTED', 'COMPLETED'])

// policy / progress / source / guidance / deadline は Command かサーバー側で決まるため strict で弾く
export const createContractSchema = z
  .object({
    name: shortText.min(1),
    kind: contractKind,
    provider: shortText.optional(),
    note: longText.optional(),
  })
  .strict() satisfies ZodType<CreateContractRequest>

export const updateContractSchema = createContractSchema
  .partial()
  .extend({ expectedVersion })
  .strict() satisfies ZodType<UpdateContractRequest>

export const createBenefitSchema = z
  .object({
    name: shortText.min(1),
    kind: benefitKind,
    provider: shortText.optional(),
    amount: yenAmount.optional(),
    note: longText.optional(),
  })
  .strict() satisfies ZodType<CreateBenefitRequest>

export const updateBenefitSchema = createBenefitSchema
  .partial()
  .extend({ expectedVersion })
  .strict() satisfies ZodType<UpdateBenefitRequest>

export const setContractPolicySchema = z
  .object({ expectedVersion, policy: contractPolicy, note: longText.optional() })
  .strict() satisfies ZodType<SetContractPolicyRequest>

export const reportProgressSchema = z
  .object({ expectedVersion, progress: contractProgress, note: longText.optional() })
  .strict() satisfies ZodType<ReportProgressRequest>
