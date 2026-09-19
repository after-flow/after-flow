import type { ApiError } from './types'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

const TOKEN_KEY = 'after-flow.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ストレージが使えない環境では何もしない */
  }
}

export class HttpError extends Error {
  readonly status: number
  readonly body: ApiError | null

  constructor(status: number, body: ApiError | null) {
    super(body?.message ?? `通信に失敗しました（${status}）`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** FormData を送る場合（書類アップロード） */
  formData?: FormData
  signal?: AbortSignal
}

/**
 * セッション切れ（401）を受け取ったときの処理。
 * 保持しているトークンを破棄してログイン画面へ戻す。
 * ケースの個人情報がキャッシュに残らないよう、App 側で QueryClient のクリアも行う。
 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, formData, signal } = options
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  })

  // ログイン自体の失敗（認証情報の誤り）はセッション切れとして扱わない
  if (res.status === 401 && !path.startsWith('/auth/')) {
    setToken(null)
    onUnauthorized?.()
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : null

  if (!res.ok) {
    throw new HttpError(res.status, json as ApiError | null)
  }
  return json as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: 'POST', formData }),
}
