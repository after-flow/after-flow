import { spawn } from 'node:child_process'

// The generic emulator launcher uses Backend-style settings. Translate once in
// this test-only parent; the actual AI process never receives those variables.
const { FIRESTORE_EMULATOR_HOST: host } = process.env
if (!host || !/^(?:localhost|127\.0\.0\.1):[0-9]+$/.test(host)) throw new Error('A loopback test emulator is required')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|DOCUMENT_STORAGE_|BACKEND_EXECUTION_SIGNING_KEY)/.test(key)))
const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'test/firestore/*.test.ts'], {
  stdio: 'inherit', env: { ...env, AI_RUNTIME_PROJECT_ID: 'after-flow-ai-runtime-test', AI_RUNTIME_DATABASE_ID: 'ai-runtime-test', AI_RUNTIME_EMULATOR_HOST: host },
})
child.once('error', () => { process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
