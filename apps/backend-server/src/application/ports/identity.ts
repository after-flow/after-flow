/**
 * 認証のポート。
 *
 * 採用する認証 Provider はまだ決まっていない（仕様書 19 章の未確定事項）。
 * Provider 固有の処理を Adapter へ隔離し、Application が
 * issuer・audience・署名方式に依存しないようにする。
 */

export interface VerifiedIdentity {
  /** Provider が発行する安定した利用者 ID。 */
  subject: string
  /**
   * トークンが主張する tenant。
   *
   * これだけでは権限の根拠にしない。Provider がカスタムクレームの
   * 書き換えを許す構成もありうるため、membership の実在を必ず確認する。
   */
  claimedTenantId: string
  issuer: string
  expiresAt: string
}

export interface TokenVerifier {
  /**
   * 署名・issuer・audience・期限を検証する。
   *
   * 検証できないトークンは UNAUTHENTICATED、鍵の取得失敗など一時的な
   * 障害は UNAVAILABLE を投げる。両者を混ぜると、鍵配布の障害時に
   * 利用者へ「ログインし直せ」と案内してしまう。
   */
  verify(token: string): Promise<VerifiedIdentity>
}

/** 認証済みの利用者。ここから先は自己申告の値を混ぜない。 */
export interface AuthenticatedUser {
  userId: string
  tenantId: string
}
