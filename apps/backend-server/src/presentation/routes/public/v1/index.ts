import type { RegisteredRoute } from '../../../http/route.js'
import { healthRoute } from './health.js'

/**
 * 公開 API v1 の route 一覧。
 * 検証・OpenAPI 生成・契約試験はすべてこの配列を唯一の入力にする。
 */
export const publicV1Routes: RegisteredRoute[] = [healthRoute]
