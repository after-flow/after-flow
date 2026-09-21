/**
 * 認証の抽象（AuthPort）。
 *
 * `VITE_USE_MOCK=true` のときは `mock.ts`、それ以外は `firebase.ts` を使う。
 * この分岐は `import()` で行い、mock 実装を本番バンドルに含めない
 * （ADR 0001 §1「この mock は VITE_USE_MOCK=true 以外では絶対に選ばれない」）。
 */

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

export interface AuthState {
  status: AuthStatus
  uid: string | null
  email: string | null
  emailVerified: boolean
}

export const INITIAL_AUTH_STATE: AuthState = {
  status: 'loading',
  uid: null,
  email: null,
  emailVerified: false,
}

/** Firebase のエラーコード等を吸収し、画面向けの文言に変換しやすい形で投げる */
export class AuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

export interface AuthPort {
  subscribe(cb: (state: AuthState) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  /** キャッシュ済みなら同期的に近い速さで返る。force=true は強制更新（`getIdToken(true)`）。 */
  getToken(force?: boolean): Promise<string | null>
  sendEmailVerification(): Promise<void>
  /** サーバー側の emailVerified を読み直す（Emulator のログや別タブで確認した後に使う） */
  reload(): Promise<void>
  sendPasswordReset(email: string): Promise<void>
}

/**
 * 本番ビルドでは `VITE_USE_MOCK` は既定で false（main.tsx 参照）。
 * この判定は main.tsx の bootstrap 判定と同じロジックにそろえる。
 */
export function mockAuthEnabled(): boolean {
  return import.meta.env.DEV
    ? import.meta.env.VITE_USE_MOCK !== 'false'
    : import.meta.env.VITE_USE_MOCK === 'true'
}

let portPromise: Promise<AuthPort> | null = null
let portOverride: AuthPort | null = null

/** AuthPort の選択と初期化を1回だけ行う。 */
export function getAuthPort(): Promise<AuthPort> {
  if (portOverride) return Promise.resolve(portOverride)
  if (!portPromise) {
    portPromise = mockAuthEnabled()
      ? import('./mock.js').then((m) => m.mockAuthPort)
      : import('./firebase.js').then((m) => m.firebaseAuthPort)
  }
  return portPromise
}

/**
 * テスト専用の差し替え。`import.meta.env` が無い `node --test`（Vite外）から
 * `client.ts` を検証するための入口で、本番コードからは呼ばない。
 */
export function __setAuthPortForTests(port: AuthPort | null): void {
  portOverride = port
  portPromise = null
}
