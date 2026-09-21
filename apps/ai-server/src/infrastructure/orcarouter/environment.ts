import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

/** Read only the gateway key; never install Backend/Storage settings in the AI environment. */
export async function readOrcaApiKey(envFile: string | URL, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let value = env.ORCAROUTER_API_KEY
  if (value === undefined) {
    try { value = parseEnv(await readFile(envFile, 'utf8')).ORCAROUTER_API_KEY }
    catch { throw new Error('Cannot read OrcaRouter configuration file') }
  }
  if (!value?.trim() || /\s/.test(value.trim()) || value.length > 4096) throw new Error('ORCAROUTER_API_KEY is missing or invalid')
  return value.trim()
}

/** Read only non-secret fixed model identifiers for host-side smoke/evaluation commands. */
export async function readOrcaModelIds(envFile: string | URL, env: NodeJS.ProcessEnv = process.env): Promise<{ core?: string; fallback?: string }> {
  let file: Record<string, string | undefined> = {}
  if (env.AI_ORCA_CORE_MODEL === undefined || env.AI_ORCA_FALLBACK_MODEL === undefined) {
    try { file = parseEnv(await readFile(envFile, 'utf8')) }
    catch { /* The API-key reader reports a missing file; model IDs have defaults. */ }
  }
  const valid = (value: string | undefined) => value && /^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= 200 ? value : undefined
  return { core: valid(env.AI_ORCA_CORE_MODEL ?? file.AI_ORCA_CORE_MODEL), fallback: valid(env.AI_ORCA_FALLBACK_MODEL ?? file.AI_ORCA_FALLBACK_MODEL) }
}
