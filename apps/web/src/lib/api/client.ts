import type { ApiErrorBody, ApiErrorCode, ApiFailure, ApiSuccess } from '@aftercare/public-contracts'
import { getAuthPort } from '@/lib/auth/index.js'

// import.meta.env は Vite が注入する。`node --test`（Vite外）から client.test.ts が
// 読み込むときは undefined になるため、素通しできるよう既定値側で吸収する。
const BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api/v1'

/** カーソルページングの一覧。旧 `Paginated<T>` の `total` はやめ、続きの有無は `nextCursor` で表す。 */
export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | 'UNKNOWN'
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  readonly requestId: string | null

  constructor(status: number, body: ApiErrorBody | null, requestId: string | null) {
    super(body?.message ?? `通信に失敗しました（${status}）`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.code ?? 'UNKNOWN'
    this.retryable = body?.retryable ?? false
    this.details = body?.details
    this.requestId = requestId
  }
}

/**
 * セッション切れ（強制更新しても401）を受け取ったときの処理。
 * App 側（SessionExpiryHandler）がサインアウト＋キャッシュ破棄を登録する。
 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

/**
 * メール確認が要る（BE の 403 FORBIDDEN details.reason:'EMAIL_NOT_VERIFIED'）ときの処理。
 * BE を唯一の判定者にするため、FE はここで受けてから `/verify-email` へ送る（§検討推奨7）。
 */
let onEmailNotVerified: (() => void) | null = null

export function setEmailNotVerifiedHandler(handler: () => void) {
  onEmailNotVerified = handler
}

function isEmailNotVerified(failure: ApiFailure | null): boolean {
  return failure?.error.code === 'FORBIDDEN' && failure.error.details?.reason === 'EMAIL_NOT_VERIFIED'
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** FormData を送る場合（書類アップロード） */
  formData?: FormData
  signal?: AbortSignal
  /** true の要求（POST/PATCH）には Idempotency-Key を自動付与する。既定は method から判定。 */
  idempotent?: boolean
}

function isJsonError(text: string): ApiFailure | null {
  if (!text) return null
  try {
    const json = JSON.parse(text) as unknown
    if (json && typeof json === 'object' && 'error' in json) return json as ApiFailure
    return null
  } catch {
    return null
  }
}

/**
 * 1回の要求を送る。401 は「強制更新 → 1回だけ再送 → それでも401ならサインアウト」、
 * 403 FORBIDDEN(NOT_REGISTERED) は「POST /me → 1回だけ再送」で吸収する（§2.6）。
 * Idempotency-Key は `request()` 1回（このリトライも含む一連）につき1つを使い回す。
 */
async function send(path: string, options: RequestOptions, idempotencyKey: string | null): Promise<{ res: Response; text: string }> {
  const { method = 'GET', body, formData, signal } = options
  const headers: Record<string, string> = {}
  const port = await getAuthPort()
  const token = await port.getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  })
  const text = res.status === 204 ? '' : await res.text()
  return { res, text }
}

function isMutatingMethod(method: string): boolean {
  return method === 'POST' || method === 'PATCH'
}

let registering: Promise<void> | null = null

/** POST /me を（同時要求は1回にまとめて）呼ぶ。AuthProvider の初回登録とも共有する。 */
async function registerSelf(): Promise<void> {
  if (!registering) {
    registering = request('/me', { method: 'POST' })
      .then(() => undefined)
      .finally(() => {
        registering = null
      })
  }
  return registering
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const idempotencyKey =
    (options.idempotent ?? isMutatingMethod(method)) ? crypto.randomUUID() : null

  let { res, text } = await send(path, options, idempotencyKey)

  if (res.status === 401 && path !== '/me') {
    const port = await getAuthPort()
    const refreshed = await port.getToken(true)
    if (refreshed) {
      ;({ res, text } = await send(path, options, idempotencyKey))
    }
    if (res.status === 401) {
      onUnauthorized?.()
      const failure = isJsonError(text)
      throw new ApiError(401, failure?.error ?? null, failure?.meta.requestId ?? null)
    }
  }

  if (res.status === 403 && path !== '/me') {
    const failure = isJsonError(text)
    if (failure?.error.code === 'FORBIDDEN' && failure.error.details?.reason === 'NOT_REGISTERED') {
      try {
        await registerSelf()
        ;({ res, text } = await send(path, options, idempotencyKey))
      } catch {
        /* 登録に失敗したら元の403をそのまま投げる */
      }
    }
  }

  if (res.status === 403 && isEmailNotVerified(isJsonError(text))) {
    onEmailNotVerified?.()
  }

  if (!res.ok) {
    const failure = isJsonError(text)
    if (failure) throw new ApiError(res.status, failure.error, failure.meta.requestId)
    // JSON でない失敗（nginx 502 等）は UNAVAILABLE 相当に正規化する
    throw new ApiError(
      res.status,
      { code: 'UNAVAILABLE', message: '通信に失敗しました。しばらくしてからもう一度お試しください。', retryable: true },
      null,
    )
  }

  if (res.status === 204 || !text) return undefined as T
  const success = JSON.parse(text) as ApiSuccess<T>
  return success.data
}

async function requestList<T>(path: string, options: RequestOptions = {}): Promise<Page<T>> {
  const method = options.method ?? 'GET'
  const idempotencyKey =
    (options.idempotent ?? isMutatingMethod(method)) ? crypto.randomUUID() : null

  let { res, text } = await send(path, options, idempotencyKey)

  if (res.status === 401 && path !== '/me') {
    const port = await getAuthPort()
    const refreshed = await port.getToken(true)
    if (refreshed) {
      ;({ res, text } = await send(path, options, idempotencyKey))
    }
    if (res.status === 401) {
      onUnauthorized?.()
      const failure = isJsonError(text)
      throw new ApiError(401, failure?.error ?? null, failure?.meta.requestId ?? null)
    }
  }

  if (res.status === 403) {
    const failure = isJsonError(text)
    if (failure?.error.code === 'FORBIDDEN' && failure.error.details?.reason === 'NOT_REGISTERED') {
      try {
        await registerSelf()
        ;({ res, text } = await send(path, options, idempotencyKey))
      } catch {
        /* 元の403をそのまま投げる */
      }
    }
  }

  if (res.status === 403 && isEmailNotVerified(isJsonError(text))) {
    onEmailNotVerified?.()
  }

  if (!res.ok) {
    const failure = isJsonError(text)
    if (failure) throw new ApiError(res.status, failure.error, failure.meta.requestId)
    throw new ApiError(
      res.status,
      { code: 'UNAVAILABLE', message: '通信に失敗しました。しばらくしてからもう一度お試しください。', retryable: true },
      null,
    )
  }

  const success = JSON.parse(text) as ApiSuccess<T[]>
  return { items: success.data, nextCursor: success.meta.nextCursor }
}

/**
 * 書類の原本のように、JSON ではない中身を受け取る。
 * 認証ヘッダーが要るため <img src> に URL を直接渡せず、いったん Blob として受け取る。
 */
export async function requestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const port = await getAuthPort()
  const headers: Record<string, string> = {}
  const token = await port.getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE_URL}${path}`, { headers, signal })
  if (res.status === 401) {
    const refreshed = await port.getToken(true)
    if (refreshed) return requestBlob(path, signal)
    onUnauthorized?.()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const failure = isJsonError(text)
    throw new ApiError(res.status, failure?.error ?? null, failure?.meta.requestId ?? null)
  }
  return res.blob()
}

const MAX_ALL_PAGES = 10
const ALL_PAGE_SIZE = 100

/**
 * 全ページ取得ヘルパー。`limit=100` で `nextCursor` を最大10ページ追う。
 * 1ケースのデータ量は小さく、画面は全件前提で組まれているため。
 */
export async function getAll<T>(path: string): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 0; page < MAX_ALL_PAGES; page++) {
    const query = `${sep}limit=${ALL_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const result = await requestList<T>(`${path}${query}`)
    items.push(...result.items)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return items
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>(path, { method: 'PATCH', body, signal }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: 'POST', formData }),
  blob: (path: string, signal?: AbortSignal) => requestBlob(path, signal),
  list: <T>(path: string, signal?: AbortSignal) => requestList<T>(path, { signal }),
}
