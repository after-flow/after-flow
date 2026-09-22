import type { KyoukaikenpoBurialBenefitResource } from '@aftercare/public-contracts'

export type KyoukaikenpoBurialBenefitInput = Omit<KyoukaikenpoBurialBenefitResource, 'missingFields'>

export interface KyoukaikenpoBurialBenefitDraft {
  branch: string
  deceasedInsuranceStatus: '' | NonNullable<KyoukaikenpoBurialBenefitResource['deceasedInsuranceStatus']>
  applicantStatus: '' | NonNullable<KyoukaikenpoBurialBenefitResource['applicantStatus']>
}

/** 表示対象だけを入力値で置き換え、表示していない既存値は丸ごと置換PATCHのために保持する。 */
export function mergeKyoukaikenpoBurialBenefitInput(
  current: KyoukaikenpoBurialBenefitResource,
  draft: KyoukaikenpoBurialBenefitDraft,
): KyoukaikenpoBurialBenefitInput {
  const missing = new Set(current.missingFields)
  return {
    branch: missing.has('BRANCH') ? draft.branch.trim() || null : current.branch,
    deceasedInsuranceStatus: missing.has('DECEASED_INSURANCE_STATUS')
      ? draft.deceasedInsuranceStatus || null
      : current.deceasedInsuranceStatus,
    applicantStatus: missing.has('APPLICANT_STATUS')
      ? draft.applicantStatus || null
      : current.applicantStatus,
  }
}

/** MSWでもBackendと同様に、保存値そのものから不足項目を決める。 */
export function withKyoukaikenpoBurialBenefitMissingFields(
  input: KyoukaikenpoBurialBenefitInput,
): KyoukaikenpoBurialBenefitResource {
  return {
    ...input,
    missingFields: [
      ...(!input.branch ? ['BRANCH' as const] : []),
      ...(input.deceasedInsuranceStatus === null ? ['DECEASED_INSURANCE_STATUS' as const] : []),
      ...(input.applicantStatus === null ? ['APPLICANT_STATUS' as const] : []),
    ],
  }
}
