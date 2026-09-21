import { Firestore } from '@google-cloud/firestore'

/** This factory never reads Backend configuration or credential files. */
export function createRuntimeFirestore(env: NodeJS.ProcessEnv = process.env): Firestore {
  if (Object.keys(env).some(key => /^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|DOCUMENT_STORAGE_|BACKEND_EXECUTION_SIGNING_KEY)/.test(key) && env[key])) {
    throw new Error('AI runtime must not receive business data configuration')
  }
  const projectId = env.AI_RUNTIME_PROJECT_ID
  const databaseId = env.AI_RUNTIME_DATABASE_ID
  if (!projectId || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !databaseId || !/^ai-runtime(?:-[a-z0-9-]+)?$/.test(databaseId)) {
    throw new Error('Explicit AI runtime project and dedicated ai-runtime database are required')
  }
  const host = env.AI_RUNTIME_EMULATOR_HOST
  if (host && (!/^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(host) || Number(host.split(':')[1]) > 65535)) throw new Error('Runtime emulator must be loopback')
  return new Firestore({ projectId, databaseId, ...(host ? { host, ssl: false, credentials: { client_email: 'emulator@example.test', private_key: 'unused' } } : {}) })
}
