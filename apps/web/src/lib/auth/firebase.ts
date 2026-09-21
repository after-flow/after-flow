import { initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  getIdToken,
  onAuthStateChanged,
  reload as firebaseReload,
  sendEmailVerification as firebaseSendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { AuthError, type AuthPort, type AuthState } from './index.js'

/**
 * Firebase JS SDK 実装（modular API）。`firebase/app` と `firebase/auth` だけを import する
 * （`scripts/verify-boundaries.mjs` は `@aftercare/*` の依存だけを検査するため追加可）。
 *
 * 本番ビルドで `VITE_FIREBASE_API_KEY` が無い・`VITE_FIREBASE_AUTH_EMULATOR_URL` が設定されている
 * 場合の fail-closed 判定は `main.tsx` の bootstrap で行う。ここでは初期化だけを行う。
 */

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
})

const auth = getAuth(app)

const emulatorUrl = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL
if (emulatorUrl) {
  connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true })
}

function stateOf(user: User | null): AuthState {
  if (!user) return { status: 'signed-out', uid: null, email: null, emailVerified: false }
  return { status: 'signed-in', uid: user.uid, email: user.email, emailVerified: user.emailVerified }
}

/** Firebase のエラーコード（`auth/xxx`）をそのまま AuthError.code として伝える。文言は画面側で分岐する。 */
function rethrow(err: unknown): never {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'auth/unknown'
  const message = err instanceof Error ? err.message : '認証に失敗しました。'
  throw new AuthError(code, message)
}

/**
 * `onAuthStateChanged` はサインイン・アウトでしか発火せず、`reload()` で
 * `emailVerified` が変わっても呼ばれない。reload 後は自分で購読者に流す。
 */
const listeners = new Set<(state: AuthState) => void>()

export const firebaseAuthPort: AuthPort = {
  subscribe(cb) {
    listeners.add(cb)
    const unsubscribe = onAuthStateChanged(auth, (user) => cb(stateOf(user)))
    return () => {
      listeners.delete(cb)
      unsubscribe()
    }
  },
  async signIn(email, password) {
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (err) {
      rethrow(err)
    }
  },
  async signUp(email, password) {
    try {
      await createUserWithEmailAndPassword(auth, email, password)
    } catch (err) {
      rethrow(err)
    }
  },
  async signOut() {
    await firebaseSignOut(auth)
  },
  async getToken(force = false) {
    const user = auth.currentUser
    if (!user) return null
    try {
      return await getIdToken(user, force)
    } catch {
      return null
    }
  },
  async sendEmailVerification() {
    if (!auth.currentUser) return
    try {
      await firebaseSendEmailVerification(auth.currentUser)
    } catch (err) {
      rethrow(err)
    }
  },
  async reload() {
    if (!auth.currentUser) return
    await firebaseReload(auth.currentUser)
    const state = stateOf(auth.currentUser)
    for (const cb of listeners) cb(state)
  },
  async sendPasswordReset(email) {
    try {
      await sendPasswordResetEmail(auth, email)
    } catch (err) {
      rethrow(err)
    }
  },
}
