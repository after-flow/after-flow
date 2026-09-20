import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dispatchSchema, internalResultSchema, internalRoutes } from '@aftercare/internal-contracts'
import { buildInternalOpenApiDocument } from '../src/presentation/openapi/internal-document.js'
import { buildOpenApiDocument } from '../src/presentation/openapi/document.js'
import { publicV1Specs } from '../src/presentation/routes/public/v1/index.js'

describe('内部契約の分離', () => {
  it('provider runtimeと内部OpenAPIのrouteが一致し、公開OpenAPIに混入しない', () => {
    const internal = buildInternalOpenApiDocument()
    const publicApi = buildOpenApiDocument(publicV1Specs, { version: 'test', basePath: '/api/v1' })
    for (const route of Object.values(internalRoutes)) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}')
      assert.ok(internal.paths[path])
      assert.equal(publicApi.paths[path], undefined)
    }
    assert.equal(Object.keys(internal.paths).length, Object.keys(internalRoutes).length + 3)
    assert.equal(JSON.stringify(publicApi).includes('X-Execution-Authorization'), false)
  })
  it('dispatchへtenant/Case本文/userBearer/任意promptを追加できない', () => {
    const dispatch = { jobId: 'job', runId: 'run', executionAttempt: 'attempt', operation: 'case_planning',
      issuedAt: 1, expiresAt: 2, executionAuthorization: 'opaque' }
    assert.equal(dispatchSchema.safeParse(dispatch).success, true)
    for (const key of ['tenantId', 'caseId', 'body', 'userBearer', 'prompt', 'model', 'tools']) {
      assert.equal(dispatchSchema.safeParse({ ...dispatch, [key]: 'forged' }).success, false)
    }
    assert.equal(dispatchSchema.safeParse({ ...dispatch, operation: 'arbitrary_agent' }).success, false)
  })
  it('結果で自己申告role/tenant、任意業務変更、待機を最終結果に偽装する操作を拒否する', () => {
    const result = { kind: 'case_planning', resultId: 'result', status: 'SUCCEEDED',
      caseVersion: 1, contextSnapshotId: 'snapshot', artifactVersion: 1, contentHash: 'a'.repeat(43), fencingToken: 1 }
    assert.equal(internalResultSchema.safeParse(result).success, true)
    for (const key of ['tenantId', 'caseId', 'role', 'payload', 'approvalRequired']) {
      assert.equal(internalResultSchema.safeParse({ ...result, [key]: 'forged' }).success, false)
    }
    assert.equal(internalResultSchema.safeParse({ ...result, status: 'WAITING_APPROVAL' }).success, false)
  })
})
