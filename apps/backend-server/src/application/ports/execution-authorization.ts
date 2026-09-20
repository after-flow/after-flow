import type { ExecutionClaims } from '@aftercare/internal-contracts'

export interface ExecutionAuthorization {
  issue(claims: ExecutionClaims): Promise<string>
  verify(token: string): Promise<ExecutionClaims>
}
