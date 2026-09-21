#!/usr/bin/env node
/**
 * ローカル開発専用。Firebase Auth Emulator に対してサインアップ・サインインし、
 * Backend が受け入れる ID token（AUTH_MODE=firebase-emulator）を取得する。
 * Frontend の実ログインの代替として Swagger UI や curl から使う。
 * 本番の Firebase Authentication へは接続しない（Emulator 専用）。
 *
 *   node apps/backend-server/scripts/dev-firebase.mjs token --email <email> --password <password>
 *     Emulator にアカウントが無ければ作成する（あれば同じパスワードでサインインする）。
 *     emailVerified を true にしてから ID token を標準出力へ出す（有効約1時間）。
 *   node apps/backend-server/scripts/dev-firebase.mjs verify-email --email <email>
 *     既存アカウントの emailVerified を true にする（FE の /signup 直後にメール確認を通す用途）。
 *
 * 接続先は FIREBASE_AUTH_EMULATOR_HOST（既定 firebase-auth-emulator:9099。
 * Docker コンテナ内から呼ぶ前提のホスト名）。
 */
import { parseArgs } from 'node:util'

if (process.env.NODE_ENV === 'production') fail('dev-firebase は本番環境では使えません。')

const HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'firebase-auth-emulator:9099'
const API_KEY = process.env.VITE_FIREBASE_API_KEY || 'demo-api-key'
const BASE = `http://${HOST}/identitytoolkit.googleapis.com/v1`

const [command, ...rest] = process.argv.slice(2)
if (command === 'token') await token(rest)
else if (command === 'verify-email') await verifyEmail(rest)
else fail('使い方: dev-firebase.mjs token --email <email> --password <password> | verify-email --email <email>')

async function call(method, body) {
  const response = await fetch(`${BASE}/${method}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  return { ok: response.ok, body: json }
}

async function signUpOrSignIn(email, password) {
  const signUp = await call('accounts:signUp', { email, password, returnSecureToken: true })
  if (signUp.ok) return signUp.body
  if (signUp.body?.error?.message === 'EMAIL_EXISTS') {
    const signIn = await call('accounts:signInWithPassword', { email, password, returnSecureToken: true })
    if (!signIn.ok) fail(`サインインに失敗しました: ${JSON.stringify(signIn.body)}`)
    return signIn.body
  }
  fail(`サインアップに失敗しました: ${JSON.stringify(signUp.body)}`)
}

/** メール確認は Emulator の「owner」bearer で Admin 相当の更新として行う（idToken 不要）。 */
async function setEmailVerified(localId) {
  const response = await fetch(`${BASE}/accounts:update?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, emailVerified: true }),
  })
  if (!response.ok) fail(`emailVerified の更新に失敗しました: ${await response.text()}`)
}

/**
 * `accounts:lookup` を owner bearer で呼ぶ（本来は要 ID token/OAuth の Admin 相当 API だが、
 * Emulator は `Authorization: Bearer owner` を無条件に受理する）。emailVerified の更新
 * （`setEmailVerified`）と同じ資格情報。
 */
async function findLocalIdByEmail(email) {
  const response = await fetch(`${BASE}/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ email: [email] }),
  })
  if (!response.ok) fail(`利用者情報の取得に失敗しました: ${await response.text()}`)
  const { users } = await response.json()
  const found = users?.[0]
  if (!found) fail(`${email} のアカウントが Emulator に見つかりません。先に signup してください。`)
  return found.localId
}

async function token(args) {
  const { values } = parseArgs({ args, options: { email: { type: 'string' }, password: { type: 'string' } } })
  if (!values.email || !values.password) fail('--email と --password を指定してください。')
  const account = await signUpOrSignIn(values.email, values.password)
  await setEmailVerified(account.localId)
  // accounts:update（owner bearer）は idToken を返さない。account.idToken は
  // emailVerified を更新する前に発行されたものなので email_verified:false が
  // 焼き込まれたままになる。更新後に signInWithPassword でトークンを取り直す。
  const refreshed = await call('accounts:signInWithPassword', {
    email: values.email,
    password: values.password,
    returnSecureToken: true,
  })
  if (!refreshed.ok) fail(`emailVerified 反映後のサインインに失敗しました: ${JSON.stringify(refreshed.body)}`)
  process.stdout.write(`${refreshed.body.idToken}\n`)
}

async function verifyEmail(args) {
  const { values } = parseArgs({ args, options: { email: { type: 'string' } } })
  if (!values.email) fail('--email を指定してください。')
  const localId = await findLocalIdByEmail(values.email)
  await setEmailVerified(localId)
  console.log(JSON.stringify({ result: 'verified', email: values.email }))
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
