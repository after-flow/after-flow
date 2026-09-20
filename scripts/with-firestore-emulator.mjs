#!/usr/bin/env node
/**
 * Firestore Emulator をコンテナで起動し、その間だけ指定コマンドを実行する。
 *
 * Emulator は Java を必要とするが、ホストへ JDK を入れずに動かせるよう
 * Docker のみを前提にしている。開発機と CI で同じ手順になる。
 *
 * 使い方:
 *   node scripts/with-firestore-emulator.mjs -- pnpm --filter @aftercare/backend-server test:firestore
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const IMAGE =
  process.env.FIRESTORE_EMULATOR_IMAGE ??
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators'
const PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8085)
const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID ?? 'after-flow-test'
const CONTAINER = process.env.FIRESTORE_EMULATOR_CONTAINER ?? 'after-flow-firestore-emulator'
const READY_TIMEOUT_MS = Number(process.env.FIRESTORE_EMULATOR_TIMEOUT_MS ?? 120_000)

const separator = process.argv.indexOf('--')
const command = separator === -1 ? [] : process.argv.slice(separator + 1)
if (command.length === 0) {
  console.error('実行するコマンドを `--` の後ろに指定してください。')
  process.exit(2)
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options })
    child.on('close', (code, signal) => resolve({ code, signal }))
    child.on('error', (error) => {
      console.error(error.message)
      resolve({ code: 127, signal: null })
    })
  })
}

function capture(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', () => resolve({ code: 127, out: '' }))
  })
}

async function stopEmulator() {
  await capture('docker', ['rm', '--force', CONTAINER])
}

async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return true
    } catch {
      // 起動途中。接続できるまで待つ。
    }
    const status = await capture('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER])
    if (status.code !== 0 || status.out.trim() !== 'true') {
      const logs = await capture('docker', ['logs', '--tail', '50', CONTAINER])
      console.error('Firestore Emulator のコンテナが停止しました。')
      console.error(logs.out)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.error(`Firestore Emulator が ${READY_TIMEOUT_MS} ms 以内に起動しませんでした。`)
  return false
}

async function main() {
  // 前回の残骸があると port が衝突する。起動前に必ず掃除する。
  await stopEmulator()

  const started = await capture('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    CONTAINER,
    '--publish',
    `127.0.0.1:${PORT}:${PORT}`,
    IMAGE,
    'gcloud',
    'emulators',
    'firestore',
    'start',
    `--host-port=0.0.0.0:${PORT}`,
  ])

  if (started.code !== 0) {
    console.error('Firestore Emulator を起動できませんでした。')
    console.error(started.out)
    process.exit(1)
  }

  let exitCode = 1
  try {
    if (!(await waitUntilReady())) {
      process.exitCode = 1
      return
    }
    console.log(`Firestore Emulator ready on 127.0.0.1:${PORT}`)
    const result = await run(command[0], command.slice(1), {
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${PORT}`,
        FIRESTORE_PROJECT_ID: PROJECT_ID,
        // 実プロジェクトの資格情報を拾わせない。
        GOOGLE_APPLICATION_CREDENTIALS: '',
      },
    })
    exitCode = result.code ?? 1
  } finally {
    await stopEmulator()
  }

  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void stopEmulator().then(() => process.exit(130))
  })
}

await main()
