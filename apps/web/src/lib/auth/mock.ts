import type { AuthPort, AuthState } from './index.js'

/**
 * `VITE_USE_MOCK=true` 用の認証。
 *
 * 任意のメール・パスワードで成功する。ADR 0001 §1「この mock は
 * VITE_USE_MOCK=true 以外では絶対に選ばれない」の実体。旧 `/auth/login`
 * ハンドラの代わりに、ここでサインインを完結させる（MSW は Authorization を検査しない）。
 */

const KEY = 'after-flow.mock-auth'

interface StoredUser {
  email: string
  emailVerified: boolean
}

function readStored(): StoredUser | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as StoredUser) : null
  } catch {
    return null
  }
}

function writeStored(user: StoredUser | null) {
  try {
    if (user) sessionStorage.setItem(KEY, JSON.stringify(user))
    else sessionStorage.removeItem(KEY)
  } catch {
    /* 使えない環境では何もしない */
  }
}

function uidOf(email: string): string {
  return `mock_${email.toLowerCase()}`
}

function stateOf(user: StoredUser | null): AuthState {
  if (!user) return { status: 'signed-out', uid: null, email: null, emailVerified: false }
  return { status: 'signed-in', uid: uidOf(user.email), email: user.email, emailVerified: user.emailVerified }
}

const listeners = new Set<(s: AuthState) => void>()

function emit() {
  const s = stateOf(readStored())
  for (const cb of listeners) cb(s)
}

export const mockAuthPort: AuthPort = {
  subscribe(cb) {
    listeners.add(cb)
    // 初回は現在の状態を非同期で1回だけ通知する（Firebase の onAuthStateChanged と同じ非同期性にそろえる）
    queueMicrotask(() => cb(stateOf(readStored())))
    return () => listeners.delete(cb)
  },
  async signIn(email) {
    writeStored({ email, emailVerified: true })
    emit()
  },
  async signUp(email) {
    writeStored({ email, emailVerified: true })
    emit()
  },
  async signOut() {
    writeStored(null)
    emit()
  },
  async getToken() {
    const user = readStored()
    return user ? 'mock-token' : null
  },
  async sendEmailVerification() {
    /* mock は常に確認済み扱いなので何もしない */
  },
  async reload() {
    emit()
  },
  async sendPasswordReset() {
    /* mock では何もしない */
  },
}
