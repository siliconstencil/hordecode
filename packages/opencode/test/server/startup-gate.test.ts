import { expect, test } from "bun:test"
import { createGatedServer } from "../../src/server/startup-gate"

// The unit under test is the raw node:http server factory that serverLayer hands to
// NodeHttpServer.layer, so this test drives it directly instead of the Effect HTTP stack.

const listen = (server: ReturnType<typeof createGatedServer>) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  )

const close = (server: ReturnType<typeof createGatedServer>) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

test("a request accepted before the handler is attached is answered once it is", async () => {
  const server = createGatedServer()
  const port = await listen(server)
  const early = fetch(`http://127.0.0.1:${port}/early`)
  await Bun.sleep(200)
  const seen: string[] = []
  server.on("request", (req, res) => {
    seen.push(req.url ?? "")
    res.statusCode = 200
    res.end("ok")
  })
  const res = await early
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("ok")
  const late = await fetch(`http://127.0.0.1:${port}/late`)
  expect(late.status).toBe(200)
  expect(seen).toEqual(["/early", "/late"])
  await close(server)
})

test("a server closed before any handler arrived answers queued requests with 503", async () => {
  const server = createGatedServer()
  const port = await listen(server)
  const early = fetch(`http://127.0.0.1:${port}/early`)
  await Bun.sleep(200)
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  const res = await early
  expect(res.status).toBe(503)
  server.closeAllConnections()
  await closed
})
