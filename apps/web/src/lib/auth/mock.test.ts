import assert from 'node:assert/strict'
import { beforeEach, it } from 'node:test'
import { mockAuthPort } from './mock.js'

/**
 * `--experimental-webstorage`（scripts/test-workspace.mjs）で有効になる sessionStorage を使う。
 * ADR 0001 §1「この mock は VITE_USE_MOCK=true 以外では絶対に選ばれない」の実体は
 * `lib/auth/index.ts` の `import()` 分岐にあるので、ここでは mock.ts 単体の振る舞いだけを見る。
 */
beforeEach(() => {
  sessionStorage.clear()
})

it('signIn 前は signed-out で、uid・email は無い', async () => {
  const states: ReturnType<typeof capture>[] = []
  function capture(s: Parameters<Parameters<typeof mockAuthPort.subscribe>[0]>[0]) {
    return { status: s.status, uid: s.uid, email: s.email, emailVerified: s.emailVerified }
  }
  const unsubscribe = mockAuthPort.subscribe((s) => states.push(capture(s)))
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  unsubscribe()
  assert.deepEqual(states, [{ status: 'signed-out', uid: null, email: null, emailVerified: false }])
})

it('任意のメール・パスワードで signIn でき、emailVerified は常に true', async () => {
  await mockAuthPort.signIn('taro@example.com', 'anything')
  const token = await mockAuthPort.getToken()
  assert.equal(token, 'mock-token')

  const states: string[] = []
  const unsubscribe = mockAuthPort.subscribe((s) => states.push(`${s.status}:${s.email}:${s.emailVerified}`))
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  unsubscribe()
  assert.deepEqual(states, ['signed-in:taro@example.com:true'])
})

it('同じメールアドレスは同じ uid になる（mock_プレフィックス＋小文字化）', async () => {
  await mockAuthPort.signIn('Taro@Example.com', 'x')
  const states: (string | null)[] = []
  const unsubscribe = mockAuthPort.subscribe((s) => states.push(s.uid))
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  unsubscribe()
  assert.deepEqual(states, ['mock_taro@example.com'])
})

it('signOut すると signed-out に戻り、getToken は null を返す', async () => {
  await mockAuthPort.signIn('hanako@example.com', 'x')
  await mockAuthPort.signOut()
  const token = await mockAuthPort.getToken()
  assert.equal(token, null)
})

it('sendEmailVerification / sendPasswordReset は例外を投げない（mockは常に確認済み扱い）', async () => {
  await mockAuthPort.signIn('jiro@example.com', 'x')
  await assert.doesNotReject(() => mockAuthPort.sendEmailVerification())
  await assert.doesNotReject(() => mockAuthPort.sendPasswordReset('jiro@example.com'))
})

it('reload は現在の状態を再通知する', async () => {
  await mockAuthPort.signIn('saburo@example.com', 'x')
  const states: string[] = []
  const unsubscribe = mockAuthPort.subscribe((s) => states.push(s.status))
  await mockAuthPort.reload()
  unsubscribe()
  assert.ok(states.includes('signed-in'))
})
