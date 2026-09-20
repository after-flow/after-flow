import { createServer } from 'node:http'

// Independent-process consumer fixture. It does not claim to implement Backend authorization.
let capability = 'fixture-capability'
const server = createServer(async (req, res) => {
  const requestId = String(req.headers['x-request-id'])
  if (requestId === 'request-timeout') return
  if (requestId === 'request-redirect') {
    res.writeHead(302, { Location: '/never-follow' }).end()
    return
  }
  if (requestId === 'request-error') {
    res.writeHead(403).end('SECRET-DO-NOT-RETURN')
    return
  }
  if (requestId === 'request-huge') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(' '.repeat(150000))
    return
  }
  if (requestId === 'request-invalid') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{"wrong":true}}')
    return
  }
  if (req.headers.authorization !== 'Bearer fixture-service' || req.headers['x-audience'] !== 'backend-internal' ||
      req.headers['x-execution-authorization'] !== capability || req.headers['x-job-id'] !== 'job-1' ||
      req.headers['x-execution-attempt'] !== 'attempt-1' || !requestId ||
      Number(req.headers['x-expires-at']) - Number(req.headers['x-issued-at']) !== 60 || !req.url?.startsWith('/internal/v1/runs/run-1/')) {
    res.writeHead(401).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString()
  process.send?.({ type: 'request', method: req.method, path: req.url, requestId, body })
  let data: unknown
  if (req.url.endsWith('/control')) data = { instruction: 'CONTINUE', reason: null, caseVersion: 1 }
  else if (req.url.endsWith('/heartbeat')) {
    capability = 'fixture-renewed'
    data = { accepted: true, executionAuthorization: capability }
  } else if (req.url.endsWith('/events') || req.url.endsWith('/result')) data = { applied: false, reason: 'ALREADY_APPLIED' }
  else if (req.url.endsWith('/proposals')) data = { proposalId: 'proposal-1', approvalId: 'approval-1', proposalVersion: 1, payloadHash: 'fixture-hash', waitRequestId: null, applicationStatus: 'NOT_APPLIED' }
  else if (req.url.endsWith('/wait-requests')) data = { waitRequestId: 'wait-1', state: 'PENDING_SNAPSHOT' }
  else data = { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1,
    contentHash: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString(), content: { operation: 'chat_reply' } }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data, meta: { requestId } }))
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port })
})
process.once('disconnect', () => { server.closeAllConnections(); server.close() })
