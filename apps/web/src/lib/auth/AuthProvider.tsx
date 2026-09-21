import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, api } from '@/lib/api/client.js'
import type { MeResource } from '@aftercare/public-contracts'
import { getAuthPort, INITIAL_AUTH_STATE, type AuthState } from './index.js'

/**
 * 認証済み利用者の登録状態（React context）。
 *
 * `signed-in` になった時点で `POST /me` を1回だけ呼び、`registered` を保持する。
 * メール確認の要否は判定しない（唯一の判定者は BE。§検討推奨7）。BE が 403
 * `EMAIL_NOT_VERIFIED` を返した場合は `client.ts` の `setEmailNotVerifiedHandler` が
 * `/verify-email` へ遷移させ、ここでは再試行できる状態に戻すだけにする。
 * StrictMode の二重実行は `registeringFor` ref で抑止する（§2.6）。
 */
export type RegistrationState =
  | { status: 'idle' | 'pending' }
  | { status: 'registered'; me: MeResource }
  | { status: 'inactive' }
  | { status: 'email-unverified' }
  | { status: 'error' }

interface AuthContextValue extends AuthState {
  registration: RegistrationState
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>(INITIAL_AUTH_STATE)
  const [registration, setRegistration] = useState<RegistrationState>({ status: 'idle' })
  const registeringFor = useRef<string | null>(null)

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    void getAuthPort().then((port) => {
      if (cancelled) return
      unsubscribe = port.subscribe(setAuth)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (auth.status !== 'signed-in' || !auth.uid) {
      if (auth.status === 'signed-out') {
        setRegistration({ status: 'idle' })
        registeringFor.current = null
      }
      return
    }
    if (registeringFor.current === auth.uid) return
    registeringFor.current = auth.uid
    setRegistration({ status: 'pending' })
    api
      .post<MeResource>('/me')
      .then((me) => setRegistration({ status: 'registered', me }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.details?.reason === 'MEMBERSHIP_INACTIVE') {
          setRegistration({ status: 'inactive' })
          return
        }
        if (err instanceof ApiError && err.details?.reason === 'EMAIL_NOT_VERIFIED') {
          // メール確認後（reload() が auth.emailVerified の変化を購読者へ流す）に再試行する
          setRegistration({ status: 'email-unverified' })
          registeringFor.current = null
          return
        }
        setRegistration({ status: 'error' })
        registeringFor.current = null
      })
  }, [auth.status, auth.emailVerified, auth.uid])

  const value: AuthContextValue = {
    ...auth,
    registration,
    signOut: async () => {
      const port = await getAuthPort()
      await port.signOut()
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth は AuthProvider の内側でのみ使えます')
  return ctx
}
