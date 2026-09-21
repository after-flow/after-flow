import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import { __setAuthPortForTests, type AuthPort, INITIAL_AUTH_STATE } from '@/lib/auth/index.js'
import { ApiError, api, getAll, request, setEmailNotVerifiedHandler, setUnauthorizedHandler } from './client.js'

/**
 * `import.meta.env` を読む `lib/auth` の実装は Vite 外（`node --test`）では動かせないため、
 * `__setAuthPortForTests` でテスト用の AuthPort に差し替えて `client.ts` だけを検証する。
 */
function fakeAuthPort(overrides: Partial<AuthPort> = {}): AuthPort {
  return {
    subscribe: () => () => {},
    signIn: async () => {},
    signUp: async () => {},
    signOut: async () => {},
    getToken: async () => 'token-1',
    sendEmailVerification: async () => {},
    reload: async () => {},
    sendPasswordReset: async () => {},
    ...overrides,
  }
}

function envelope(data: unknown, requestId = 'req-1') {
  return JSON.stringify({ data, meta: { requestId } })
}

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>, requestId = 'req-err') {
  return JSON.stringify({ error: { code, message, retryable: false, details }, meta: { requestId } })
}

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  setUnauthorizedHandler(() => {})
  setEmailNotVerifiedHandler(() => {})
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __setAuthPortForTests(null)
})

it('封筒を展開して data をそのまま返す', async () => {
  __setAuthPortForTests(fakeAuthPort())
  globalThis.fetch = (async () => new Response(envelope({ id: 'case_1' }), { status: 200 })) as typeof fetch
  const result = await request<{ id: string }>('/cases/case_1')
  assert.deepEqual(result, { id: 'case_1' })
})

it('一覧は items と nextCursor に詰め替える', async () => {
  __setAuthPortForTests(fakeAuthPort())
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: 'a' }], meta: { requestId: 'r', nextCursor: 'cursor-2' } }), {
      status: 200,
    })) as typeof fetch
  const result = await api.list<{ id: string }>('/cases')
  assert.deepEqual(result, { items: [{ id: 'a' }], nextCursor: 'cursor-2' })
})

it('POST/PATCH には Idempotency-Key を自動付与し、GET には付けない', async () => {
  __setAuthPortForTests(fakeAuthPort())
  const seenHeaders: Headers[] = []
  globalThis.fetch = (async (_url, init) => {
    seenHeaders.push(new Headers(init?.headers))
    return new Response(envelope({ ok: true }), { status: 200 })
  }) as typeof fetch

  await request('/cases', { method: 'GET' })
  await api.post('/cases', { deceasedName: 'x' })

  assert.equal(seenHeaders[0].has('Idempotency-Key'), false)
  const key = seenHeaders[1].get('Idempotency-Key')
  assert.ok(key && key.length > 0)
})

it('強制更新でトークンが取れなければ再送せずに401を投げる', async () => {
  __setAuthPortForTests(fakeAuthPort({ getToken: async (force) => (force ? null : 'token') }))
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    return new Response('', { status: 401 })
  }) as typeof fetch

  await assert.rejects(() => api.get('/cases/case_1'))
  assert.equal(call, 1)
})

it('NOT_REGISTERED の再送では Idempotency-Key を使い回す', async () => {
  __setAuthPortForTests(fakeAuthPort())
  const keysByPath: Record<string, (string | null)[]> = {}
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url), 'http://x').pathname
    const key = new Headers(init?.headers).get('Idempotency-Key')
    ;(keysByPath[path] ??= []).push(key)
    if (path === '/api/v1/me') return new Response(envelope({ userId: 'u1' }), { status: 201 })
    if (keysByPath[path].length === 1) {
      return new Response(errorEnvelope('FORBIDDEN', '未登録です', { reason: 'NOT_REGISTERED' }), { status: 403 })
    }
    return new Response(envelope({ id: 'case_1' }), { status: 201 })
  }) as typeof fetch

  await api.post('/cases', { deceasedName: 'x' })
  const [firstKey, secondKey] = keysByPath['/api/v1/cases']
  assert.ok(firstKey)
  assert.equal(firstKey, secondKey, '同じ要求の再送は同じ Idempotency-Key を使う')
})

it('失敗の JSON 本文から ApiError を組み立てる', async () => {
  __setAuthPortForTests(fakeAuthPort())
  globalThis.fetch = (async () =>
    new Response(errorEnvelope('CONFLICT', 'すでに更新されています', { reason: 'STALE' }), { status: 409 })) as typeof fetch

  await assert.rejects(
    () => request('/cases/case_1'),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 409)
      assert.equal(err.code, 'CONFLICT')
      assert.equal(err.message, 'すでに更新されています')
      assert.deepEqual(err.details, { reason: 'STALE' })
      return true
    },
  )
})

it('JSON でない失敗は UNAVAILABLE に正規化する', async () => {
  __setAuthPortForTests(fakeAuthPort())
  globalThis.fetch = (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch

  await assert.rejects(
    () => request('/cases/case_1'),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 502)
      assert.equal(err.code, 'UNAVAILABLE')
      assert.equal(err.retryable, true)
      return true
    },
  )
})

it('401 は強制更新して1回だけ再送し、それでも401ならサインアウトを呼ぶ', async () => {
  let forced = false
  __setAuthPortForTests(
    fakeAuthPort({
      getToken: async (force) => {
        if (force) forced = true
        return 'token'
      },
    }),
  )
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('', { status: 401 })
  }) as typeof fetch
  let signedOut = false
  setUnauthorizedHandler(() => {
    signedOut = true
  })

  await assert.rejects(() => request('/cases/case_1'))
  assert.equal(calls, 2, '強制更新後に1回だけ再送する')
  assert.equal(forced, true)
  assert.equal(signedOut, true)
})

it('401 が強制更新後に成功すれば結果を返す（サインアウトしない）', async () => {
  __setAuthPortForTests(fakeAuthPort())
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) return new Response('', { status: 401 })
    return new Response(envelope({ id: 'case_1' }), { status: 200 })
  }) as typeof fetch
  let signedOut = false
  setUnauthorizedHandler(() => {
    signedOut = true
  })

  const result = await request<{ id: string }>('/cases/case_1')
  assert.deepEqual(result, { id: 'case_1' })
  assert.equal(signedOut, false)
})

it('NOT_REGISTERED は POST /me を挟んで1回だけ再送する', async () => {
  __setAuthPortForTests(fakeAuthPort())
  const calledPaths: string[] = []
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url), 'http://x').pathname
    calledPaths.push(path)
    if (path === '/api/v1/me') return new Response(envelope({ userId: 'u1' }), { status: 201 })
    if (calledPaths.filter((p) => p === path).length === 1) {
      return new Response(errorEnvelope('FORBIDDEN', '未登録です', { reason: 'NOT_REGISTERED' }), { status: 403 })
    }
    return new Response(envelope({ id: 'case_1' }), { status: 200 })
  }) as typeof fetch

  const result = await request<{ id: string }>('/cases/case_1')
  assert.deepEqual(result, { id: 'case_1' })
  assert.deepEqual(calledPaths, ['/api/v1/cases/case_1', '/api/v1/me', '/api/v1/cases/case_1'])
})

it('EMAIL_NOT_VERIFIED を受けたらハンドラを呼んでからエラーを投げる', async () => {
  __setAuthPortForTests(fakeAuthPort())
  globalThis.fetch = (async () =>
    new Response(errorEnvelope('FORBIDDEN', 'メール未確認です', { reason: 'EMAIL_NOT_VERIFIED' }), {
      status: 403,
    })) as typeof fetch
  let redirected = false
  setEmailNotVerifiedHandler(() => {
    redirected = true
  })

  await assert.rejects(() => api.post('/cases', {}));
  assert.equal(redirected, true)
})

it('getAll は nextCursor が無くなるまでページを追う', async () => {
  __setAuthPortForTests(fakeAuthPort())
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      return new Response(JSON.stringify({ data: [{ id: 'a' }], meta: { requestId: 'r1', nextCursor: 'c2' } }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify({ data: [{ id: 'b' }], meta: { requestId: 'r2' } }), { status: 200 })
  }) as typeof fetch

  const items = await getAll<{ id: string }>('/cases')
  assert.deepEqual(items, [{ id: 'a' }, { id: 'b' }])
  assert.equal(call, 2)
})

it('INITIAL_AUTH_STATE は未ログイン扱いで読み込み中を表す', () => {
  assert.equal(INITIAL_AUTH_STATE.status, 'loading')
  assert.equal(INITIAL_AUTH_STATE.uid, null)
})
