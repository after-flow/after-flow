import { z } from 'zod'
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

export const caseResourceSchema = z.object({
  id: z.string(),
  deceasedName: z.string(),
  deceasedNameKana: z.string().nullable(),
  dateOfDeath: z.string(),
  dateOfBirth: z.string().nullable(),
  knownAt: z.string().nullable(),
  ownerName: z.string(),
  relationshipToDeceased: z.string(),
  municipality: z.string().nullable(),
  ownerPersonId: z.string().nullable(),
  selfPersonId: z.string().nullable(),
  aiPlanningRestriction: aiPlanningRestrictionSchema.nullable(),
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
    ownerName: nameSchema.optional(),
    relationshipToDeceased: z.string().trim().min(1).max(50).optional(),
    municipality: municipalitySchema.nullish(),
  })
  // status を含めない。終了・再開は状態遷移を検証する別の操作にする。
  .strict()

export const caseIdParamsSchema = z.object({ caseId: idSchema })
