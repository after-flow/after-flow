/**
 * 認証のポート。
 *
 * 採用 Provider は Firebase Authentication（docs/adr/0001-authentication-provider.md）。
 * Provider 固有の処理を Adapter へ隔離し、Application が
 * issuer・audience・署名方式・鍵取得方式に依存しないようにする。
 */

export interface VerifiedIdentity {
  /** Provider が発行する安定した利用者 ID（Firebase uid）。 */
  subject: string
  /** 保存も応答もしない。メール確認の判定にだけ使う。 */
  email: string | null
  emailVerified: boolean
  /**
   * Provider の `auth_time`（ISO 文字列）。
   *
   * ログイン維持の7日上限（ADR 0001 §4）の判定に使う。無いトークンは拒否する。
   */
  authTime: string | null
  issuer: string
  expiresAt: string
}

export interface TokenVerifier {
  /**
   * 署名・issuer・audience・期限・メール確認・ログイン維持上限を検証する。
   *
   * 検証できないトークンは UNAUTHENTICATED、メール未確認は FORBIDDEN
   * （トークン自体は正当なため）、鍵の取得失敗など一時的な障害は
   * UNAVAILABLE を投げる。理由を混ぜると復旧導線を誤らせる。
   */
  verify(token: string): Promise<VerifiedIdentity>
}

/**
 * tenant の membership で裏取りした認証済みの利用者。
 *
 * ここから先は自己申告の値を混ぜない。tenant はトークンの主張ではなく
 * 配備単位の設定値から決まる（`application/authorization/case-access.ts`）。
 */
export interface AuthenticatedUser {
  userId: string
  tenantId: string
}
