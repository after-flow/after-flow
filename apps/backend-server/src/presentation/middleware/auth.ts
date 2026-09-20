import type { MiddlewareHandler } from 'hono'
import type { Principal } from '../../application/context.js'
import { DomainError } from '../../domain/shared/errors.js'
import { PRINCIPAL_KEY } from '../http/request.js'
import type { AppBindings } from '../http/types.js'

/**
 * Identity Adapter の境界。Firebase Auth 等の検証実装は #6 で差し込む。
 * ここでは「検証済みの主体を返す」契約だけを定義する。
 */
export interface IdentityVerifier {
  verify(headers: Headers): Promise<Principal | null>
}

/** 認証実装が未設定の環境では保護ルートを一律 503 にし、無認証で通さない */
export class UnconfiguredIdentityVerifier implements IdentityVerifier {
  async verify(): Promise<Principal | null> {
    throw new DomainError('AUTH_NOT_CONFIGURED', '認証が設定されていないため、この API は利用できません')
  }
}

/**
 * ローカル開発・テスト専用。`AUTH_MODE=dev-header` のときだけ有効化される。
 * ヘッダーをそのまま信用するため、本番には絶対に使わない。
 */
export class DevHeaderIdentityVerifier implements IdentityVerifier {
  async verify(headers: Headers): Promise<Principal | null> {
    const userId = headers.get('x-dev-user-id')
    const tenantId = headers.get('x-dev-tenant-id') ?? 'dev'
    if (!userId) return null
    return { tenantId, userId }
  }
}

export function requireAuth(verifier: IdentityVerifier): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const principal = await verifier.verify(c.req.raw.headers)
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'ログインが必要です')
    c.set(PRINCIPAL_KEY, principal)
    await next()
  }
}
