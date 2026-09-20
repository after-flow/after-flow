import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 独立した Fake AI HTTP サーバー。
 *
 * in-process のスタブに差し替えず、実際の HTTP で接続する。
 * Backend 側の配送・再送・重複排除を、プロセス境界を跨いだ状態で試験する。
 * これは実 AI の代わりではなく、Backend の実行制御を確かめるためのもの。
 */
export interface FakeAiServer {
  url: string
  /** 受信したジョブ。重複も含めて到着順に記録する。 */
  received: { eventId: string; type: string; attempt: number; audience: string | undefined }[]
  /** eventId ごとの受信回数。 */
  countOf(eventId: string): number
  /** 重複排除して受理した eventId。 */
  accepted: Set<string>
  /** 次の応答を指定する。未指定なら 202。 */
  respondWith(status: number): void
  /** 応答を返さずに接続を切る。送信したか分からない状態を作る。 */
  dropNext(): void
  close(): Promise<void>
}

export async function startFakeAiServer(
  options: { expectedToken?: string } = {},
): Promise<FakeAiServer> {
  const received: FakeAiServer['received'] = []
  const accepted = new Set<string>()
  let nextStatus: number | null = null
  let dropNextRequest = false

  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const authorization = request.headers.authorization
      if (options.expectedToken && authorization !== `Bearer ${options.expectedToken}`) {
        response.writeHead(401).end()
        return
      }

      const job = JSON.parse(body || '{}') as { eventId?: string; type?: string; attempt?: number }
      received.push({
        eventId: job.eventId ?? '',
        type: job.type ?? '',
        attempt: job.attempt ?? 0,
        audience: request.headers['x-audience'] as string | undefined,
      })

      if (dropNextRequest) {
        dropNextRequest = false
        // 受信はしたが応答を返さずに切る。Backend からは届いたか分からない。
        request.socket.destroy()
        return
      }

      if (nextStatus !== null) {
        const status = nextStatus
        nextStatus = null
        response.writeHead(status).end()
        return
      }

      if (job.eventId && accepted.has(job.eventId)) {
        // 受信側の重複排除。既に処理済みの配送は 409 で弾く。
        response.writeHead(409).end()
        return
      }
      if (job.eventId) accepted.add(job.eventId)
      response.writeHead(202).end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    accepted,
    countOf: (eventId) => received.filter((entry) => entry.eventId === eventId).length,
    respondWith: (status) => {
      nextStatus = status
    },
    dropNext: () => {
      dropNextRequest = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
