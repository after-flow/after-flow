import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dispatchSchema } from '@aftercare/internal-contracts'
import type { RunDispatch } from '@aftercare/internal-contracts'

/** Dedicated runtime encryption key; never the Backend signing key. Keep outside Firestore. */
export class DispatchVault {
  private readonly key: Buffer
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64')
    if (this.key.length !== 32 || this.key.toString('base64') !== base64Key) throw new Error('A dedicated 256-bit runtime encryption key is required')
  }
  seal(input: RunDispatch): string {
    const dispatch = dispatchSchema.parse(input)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(dispatch.jobId))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(dispatch), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }
  open(value: string, jobId: string): RunDispatch {
    try {
      const data = Buffer.from(value, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12))
      cipher.setAAD(Buffer.from(jobId)); cipher.setAuthTag(data.subarray(12, 28))
      const dispatch = dispatchSchema.parse(JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')))
      if (dispatch.jobId !== jobId) throw new Error('Mismatch')
      return dispatch
    } catch { throw new Error('Runtime credential cannot be decrypted') }
  }
}
