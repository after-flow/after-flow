#!/usr/bin/env node
/**
 * ローカル開発専用の認証補助。
 *
 * Backend の `AUTH_MODE=static-jwks` に渡す固定 JWKS と、その鍵で署名した
 * 開発用 JWT を作る。本番の認証 Provider（Firebase Authentication）の代替ではなく、
 * Swagger UI や curl から業務 API を試すための最小の導線。
 *
 *   node apps/backend-server/scripts/dev-auth.mjs keys --out <dir>
 *     ES256 鍵対を生成し、秘密鍵を <dir>/private.jwk.json に保存する。
 *     標準出力には .env に追記する Backend 向けの設定（公開鍵のみ）を出す。
 *   node apps/backend-server/scripts/dev-auth.mjs token --key <file> --user <id> --tenant <id> [--ttl <seconds>]
 *     保存した秘密鍵で JWT を署名し、トークンだけを標準出力に出す。
 *
 * 秘密鍵は Backend コンテナへ渡さない。Backend が受け取るのは公開鍵だけ。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'

const ISSUER = 'https://after-flow.local/dev'
const AUDIENCE = 'after-flow-local'
const TENANT_CLAIM = 'tenant_id'
const ALG = 'ES256'
const ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_TTL_SECONDS = 24 * 60 * 60

if (process.env.NODE_ENV === 'production') fail('dev-auth は本番環境では使えません。')

const [command, ...rest] = process.argv.slice(2)
if (command === 'keys') await keys(rest)
else if (command === 'token') await token(rest)
else fail('使い方: dev-auth.mjs keys --out <dir> | token --key <file> --user <id> --tenant <id> [--ttl <seconds>]')

async function keys(args) {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } } })
  if (!values.out) fail('--out <dir> を指定してください。')
  const pair = await generateKeyPair(ALG, { extractable: true })
  const kid = `dev-${randomBytes(6).toString('hex')}`
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: ALG, use: 'sig' }
  const privateJwk = { ...(await exportJWK(pair.privateKey)), kid, alg: ALG }
  await mkdir(values.out, { recursive: true })
  await writeFile(join(values.out, 'private.jwk.json'), JSON.stringify(privateJwk), { mode: 0o600 })
  // Backend へ渡すのは公開鍵だけ。値に空白や # を含めないので .env にそのまま書ける。
  process.stdout.write([
    '',
    `# after-flow dev auth (${new Date().toISOString()}). static-jwks はローカル開発専用。本番では起動を拒否する。`,
    'AUTH_MODE=static-jwks',
    `AUTH_ISSUER=${ISSUER}`,
    `AUTH_AUDIENCE=${AUDIENCE}`,
    `AUTH_TENANT_CLAIM=${TENANT_CLAIM}`,
    `AUTH_STATIC_JWKS=${JSON.stringify({ keys: [publicJwk] })}`,
    '',
  ].join('\n'))
}

async function token(args) {
  const { values } = parseArgs({ args, options: {
    key: { type: 'string' }, user: { type: 'string' }, tenant: { type: 'string' }, ttl: { type: 'string', default: '28800' },
  } })
  if (!values.key) fail('--key <file> を指定してください。')
  for (const [name, value] of [['user', values.user], ['tenant', values.tenant]]) {
    if (!value || !ID.test(value)) fail(`--${name} は英数字・ハイフン・アンダースコアの1〜128文字で指定してください。`)
  }
  const ttl = Number(values.ttl)
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) fail(`--ttl は 60〜${MAX_TTL_SECONDS} 秒で指定してください。`)
  const jwk = JSON.parse(await readFile(values.key, 'utf8'))
  if (jwk.alg !== ALG || typeof jwk.kid !== 'string' || !jwk.d) fail('秘密鍵ファイルの形式が想定と違います。make dev-auth で作り直してください。')
  const privateKey = await importJWK(jwk, ALG)
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({ [TENANT_CLAIM]: values.tenant })
    .setProtectedHeader({ alg: ALG, kid: jwk.kid, typ: 'JWT' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(values.user)
    .setIssuedAt(now).setExpirationTime(now + ttl)
    .sign(privateKey)
  process.stdout.write(`${jwt}\n`)
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
