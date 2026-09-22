import { z } from 'zod'
import { PROFILE_VALUES } from '../../domain/case/case-profile.js'
import { idSchema, isoDateSchema, isoDateTimeSchema, expectedVersionSchema } from './common.js'

/**
 * Case の公開契約スキーマ。
 *
 * 保存できる項目をホワイトリストで受け取る。未知の項目は拒否し、
 * 将来の項目名をクライアントが先取りして書き込めないようにする。
 */

const nameSchema = z.string().trim().min(1).max(100)
const municipalitySchema = z.string().trim().min(1).max(50)

export const aiPlanningRestrictionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict()
export const updatePlanningRestrictionBodySchema = z.object({
  expectedVersion: expectedVersionSchema, restriction: aiPlanningRestrictionSchema.nullable(),
}).strict()

export const caseStatusSchema = z.enum(['ACTIVE', 'CLOSED'])
export const caseActionSchema = z.enum(['UPDATE_BASIC_INFO', 'ADMINISTER'])

const kyoukaikenpoBurialBenefitInputSchema = z.object({
  branch: z.string().trim().min(1).max(100).nullable(),
  deceasedInsuranceStatus: z.enum(['INSURED', 'DEPENDENT']).nullable(),
  applicantStatus: z.enum(['LIVELIHOOD_MAINTAINER', 'BURIAL_EXPENSE_PAYER']).nullable(),
}).strict()

export const kyoukaikenpoBurialBenefitResourceSchema = kyoukaikenpoBurialBenefitInputSchema.extend({
  missingFields: z.array(z.enum(['BRANCH', 'DECEASED_INSURANCE_STATUS', 'APPLICANT_STATUS'])),
})

/** `PROFILE_VALUES` を Zod と検証の唯一の出所にする（文字列を二重に書かない）。 */
export const caseProfileResourceSchema = z.object({
  healthInsurance: z.enum(PROFILE_VALUES.healthInsurance),
  pension: z.enum(PROFILE_VALUES.pension),
  occupation: z.enum(PROFILE_VALUES.occupation),
  realEstate: z.enum(PROFILE_VALUES.realEstate),
  car: z.enum(PROFILE_VALUES.car),
  mortgage: z.enum(PROFILE_VALUES.mortgage),
  answeredAt: isoDateTimeSchema,
})

export const caseProfileInputSchema = z.object({
  healthInsurance: z.enum(PROFILE_VALUES.healthInsurance).optional(),
  pension: z.enum(PROFILE_VALUES.pension).optional(),
  occupation: z.enum(PROFILE_VALUES.occupation).optional(),
  realEstate: z.enum(PROFILE_VALUES.realEstate).optional(),
  car: z.enum(PROFILE_VALUES.car).optional(),
  mortgage: z.enum(PROFILE_VALUES.mortgage).optional(),
  answeredAt: isoDateTimeSchema,
}).strict()

export const caseResourceSchema = z.object({
  id: z.string(),
  deceasedName: z.string(),
  deceasedNameKana: z.string().nullable(),
  dateOfDeath: z.string(),
  dateOfBirth: z.string().nullable(),
  knownAt: z.string().nullable(),
  profile: caseProfileResourceSchema.optional(),
  ownerName: z.string(),
  relationshipToDeceased: z.string(),
  municipality: z.string().nullable(),
  funeralCompletedAt: isoDateTimeSchema.nullable(),
  ownerPersonId: z.string().nullable(),
  selfPersonId: z.string().nullable(),
  aiPlanningRestriction: aiPlanningRestrictionSchema.nullable(),
  kyoukaikenpoBurialBenefit: kyoukaikenpoBurialBenefitResourceSchema,
  status: caseStatusSchema,
  version: z.number().int(),
  caseVersion: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  allowedActions: z.array(caseActionSchema),
})

/**
 * 作成者本人を Person として同時登録する指定。
 * 名前・続柄は ownerName / relationshipToDeceased から取り、ここでは重複入力させない。
 */
export const ownerPersonInputSchema = z
  .object({
    /** true → role HEIR_CANDIDATE、false → RELATED（既存 createPerson と同じ既定） */
    isHeir: z.boolean(),
  })
  .strict()

export const createCaseBodySchema = z
  .object({
    deceasedName: nameSchema,
    deceasedNameKana: nameSchema.nullish(),
    dateOfDeath: isoDateSchema,
    dateOfBirth: isoDateSchema.nullish(),
    /**
     * 相続の開始を知った日。
     * 死亡日と別の事実として受け取る。未入力は補完せず null のままにする。
     */
    knownAt: isoDateSchema.nullish(),
    ownerName: nameSchema,
    relationshipToDeceased: z.string().trim().min(1).max(50),
    municipality: municipalitySchema.nullish(),
    /**
     * 指定すると、ownerName / relationshipToDeceased を使って作成者本人を
     * Person として同じ Transaction で登録し、Case.ownerPersonId と
     * 作成者 membership の personId に紐付ける。省略・null なら登録しない。
     */
    ownerPerson: ownerPersonInputSchema.nullish(),
    kyoukaikenpoBurialBenefit: kyoukaikenpoBurialBenefitInputSchema.optional(),
  })
  .strict()

export const updateCaseBodySchema = z
  .object({
    // 版の指定は必須。欠落は 428 として扱う（route の expectedVersion 宣言）。
    expectedVersion: expectedVersionSchema,
    deceasedName: nameSchema.optional(),
    deceasedNameKana: nameSchema.nullish(),
    dateOfDeath: isoDateSchema.optional(),
    dateOfBirth: isoDateSchema.nullish(),
    knownAt: isoDateSchema.nullish(),
    /**
     * 丸ごと置換。省略した項目は `normalizeProfile` で UNKNOWN に正規化する。
     * `null` で未回答に戻す。キー省略（undefined）は変更しない。
     */
    profile: caseProfileInputSchema.nullish(),
    ownerName: nameSchema.optional(),
    relationshipToDeceased: z.string().trim().min(1).max(50).optional(),
    municipality: municipalitySchema.nullish(),
    /** 葬儀・火葬が済んだと記録した日時。null で「まだ」に戻す。 */
    funeralCompletedAt: isoDateTimeSchema.nullish(),
    /** 3項目を丸ごと置換する。未確認に戻す項目はnullを送る。 */
    kyoukaikenpoBurialBenefit: kyoukaikenpoBurialBenefitInputSchema.optional(),
  })
  // status を含めない。終了・再開は状態遷移を検証する別の操作にする。
  .strict()

export const caseIdParamsSchema = z.object({ caseId: idSchema })
