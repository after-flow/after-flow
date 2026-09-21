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
