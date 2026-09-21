import { serve } from '@hono/node-server'
import { createApp } from '../../app.js'
import type { ExecutionOptions } from '../../presentation/routes/internal/v1/execution.js'

/** Owns HTTP and worker lifetimes together. It never starts a detached task per request. */
export async function startExecutionHost(options: ExecutionOptions & {
  port: number; hostname?: string; shutdownMs?: number
  worker?: { run(signal: AbortSignal): Promise<void> }
}) {
  if (!!options.runtime !== !!options.worker) throw new Error('Runtime and worker must be connected together')
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid server port')
  const shutdownMs = options.shutdownMs ?? 10000
  if (!Number.isInteger(shutdownMs) || shutdownMs < 1 || shutdownMs > 30000) throw new Error('Invalid shutdown timeout')
  const abort = new AbortController()
  let resolveListening!: (port: number) => void
  let rejectListening!: (error: Error) => void
  const listening = new Promise<number>((resolve, reject) => { resolveListening = resolve; rejectListening = reject })
  const server = serve({ fetch: createApp(options).fetch, hostname: options.hostname ?? '127.0.0.1', port: options.port }, info => resolveListening(info.port))
  server.once('error', rejectListening)
  const port = await listening
  let failure = false
  const closeConnections = () => { if ('closeAllConnections' in server) server.closeAllConnections() }
  const workerFinished = () => {
    if (!abort.signal.aborted) { failure = true; abort.abort(); server.close(); closeConnections() }
  }
  const worker = options.worker ? Promise.resolve().then(() => options.worker!.run(abort.signal)).then(workerFinished, workerFinished) : Promise.resolve()
  let stopping: Promise<boolean> | undefined
  return { port,
    /** Resolves when worker stops; caller supervises unexpected termination. */
    done: worker,
    stop(): Promise<boolean> {
      if (stopping) return stopping
      stopping = (async () => {
        abort.abort()
        const closed = new Promise<void>(resolve => server.close(() => resolve()))
        let timer: ReturnType<typeof setTimeout> | undefined
        const graceful = Promise.all([closed, worker]).then(() => !failure)
        const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => { closeConnections(); resolve(false) }, shutdownMs) })
        try { return await Promise.race([graceful, timedOut]) } finally { if (timer) clearTimeout(timer) }
      })()
      return stopping
    },
  }
}
