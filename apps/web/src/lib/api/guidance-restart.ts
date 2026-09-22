import type { AgentRunResource, GuidanceResource } from '@aftercare/public-contracts'
import { agentRunIsActive } from '@/lib/model/agent-run'
import { ApiError, api } from './client'

interface GuidanceRestartClient {
  getRun(caseId: string, runId: string): Promise<AgentRunResource>
  cancelRun(caseId: string, runId: string, expectedVersion: number): Promise<AgentRunResource>
  requestGuidance(caseId: string, taskId: string): Promise<GuidanceResource>
}

const defaultClient: GuidanceRestartClient = {
  getRun: (caseId, runId) => api.get(`/cases/${caseId}/agent-runs/${runId}`),
  cancelRun: (caseId, runId, expectedVersion) =>
    api.post(`/cases/${caseId}/agent-runs/${runId}/cancel`, { expectedVersion }),
  requestGuidance: (caseId, taskId) =>
    api.post(`/cases/${caseId}/tasks/${taskId}/guidance/requests`, {}),
}

/** timeoutした案内Runを世代付きで取り消してから、新しい調査を依頼する。 */
export async function restartTimedOutGuidance(
  caseId: string,
  taskId: string,
  runId: string,
  client: GuidanceRestartClient = defaultClient,
): Promise<GuidanceResource> {
  for (let cancelAttempt = 0; cancelAttempt < 3; cancelAttempt += 1) {
    const run = await client.getRun(caseId, runId)
    if (!agentRunIsActive(run)) break
    try {
      await client.cancelRun(caseId, runId, run.version)
      break
    } catch (cause) {
      const versionConflict = cause instanceof ApiError && cause.status === 409
      if (!versionConflict || cancelAttempt === 2) throw cause
    }
  }
  return client.requestGuidance(caseId, taskId)
}
