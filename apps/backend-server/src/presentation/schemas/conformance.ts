import type { ApiErrorBody, ApiErrorCode, ApiFailure, ResponseMeta } from '@aftercare/public-contracts'
import type { z } from 'zod'
import { apiErrorBodySchema, apiErrorCodeSchema, apiFailureSchema, responseMetaSchema } from './common.js'

/**
 * Zod スキーマの出力型が公開契約の型と一致することを、型検査で保証する。
 *
 * スキーマと DTO を別々に書くと、OpenAPI の生成物だけが正しく、実際の応答が
 * 契約からずれた状態になりうる。ここが壊れたら `pnpm typecheck` が落ちる。
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

export type Assert<T extends true> = T

export type ErrorCodeMatches = Assert<Equals<z.infer<typeof apiErrorCodeSchema>, ApiErrorCode>>
export type ErrorBodyMatches = Assert<Equals<z.infer<typeof apiErrorBodySchema>, ApiErrorBody>>
export type ResponseMetaMatches = Assert<Equals<z.infer<typeof responseMetaSchema>, ResponseMeta>>
export type FailureMatches = Assert<Equals<z.infer<typeof apiFailureSchema>, ApiFailure>>
