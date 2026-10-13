import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

type Handler = (req: IncomingMessage, res: ServerResponse) => void

// Startup gate for the Effect Node HTTP listener (fork-only).
//
// @effect/platform-node NodeHttpServer.js:79 calls `server.listen()` while the server layer is
// built and only attaches the request handler (`server.on("request", handler)`,
// NodeHttpServer.js:115) once the router layer has been built. Node emits "request" for every
// connection accepted in between and, with no listener, never answers it: the client hangs.
// Measured 2026-09-21 on hordecode 0.1.1: 8 of 10 fresh `horde serve` starts left the first
// accepted request unanswered. Upstream opencode 1.18.15/1.18.29 server.ts carries the same
// window; MiMo (mimocode-v0.1.11 server.ts:112) binds its fetch handler at listen time.
//
// The gate is the only "request" listener. Until a real handler is installed it queues the
// request; the first `server.on("request", fn)` call installs `fn` and replays the queue in
// arrival order. A server closed before any handler arrived answers the queue with 503 when close() is called.
export function createGatedServer(): Server {
  const server = createServer()
  const pending: Array<[IncomingMessage, ServerResponse]> = []
  let handler: Handler | undefined

  const gate: Handler = (req, res) => {
    if (handler) return handler(req, res)
    pending.push([req, res])
  }
  server.on("request", gate)

  const install = (fn: Handler) => {
    handler = fn
    for (const [req, res] of pending.splice(0)) fn(req, res)
  }

  const on = server.on.bind(server)
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.on = ((event: string | symbol, fn: (...args: any[]) => void) => {
    if (event === "request" && fn !== gate) {
      install(fn as Handler)
      return server
    }
    return on(event as string, fn)
  }) as typeof server.on
  server.addListener = server.on

  const flush503 = () => {
    for (const [, res] of pending.splice(0)) {
      if (res.headersSent) continue
      res.statusCode = 503
      res.setHeader("Connection", "close")
      res.end()
    }
  }
  // server.close() only emits "close" once every connection has ended, and a queued request keeps
  // its connection open until it is answered, so answer the queue when close is initiated.
  const closeOriginal = server.close.bind(server)
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    flush503()
    return closeOriginal(callback)
  }) as typeof server.close

  return server
}
