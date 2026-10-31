import { describe, expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { Authorization, authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { ServerAuth } from "@opencode-ai/server/auth"
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "@opencode-ai/protocol/groups/pty"
import "./preload"

const Username = "hordecode"
const Reached = Schema.Struct({ route: Schema.String })
const params = { ptyID: Schema.String }

// Probe routes behind the real Authorization middleware: the PTY connect route at its real path and a
// sibling PTY route. Only the connect route may skip credential checks, and only when a ticket is present.
const ProbeGroup = HttpApiGroup.make("probe")
  .add(HttpApiEndpoint.get("connect", PTY_CONNECT_PATH, { params, success: Reached }))
  .add(HttpApiEndpoint.get("other", "/api/pty/:ptyID/other", { params, success: Reached }))
  .middleware(Authorization)

const ProbeApi = HttpApi.make("probe-api").add(ProbeGroup)

const ProbeHandler = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("connect", () => Effect.succeed({ route: "connect" }))
    .handle("other", () => Effect.succeed({ route: "other" })),
)

const appLayer = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(ProbeHandler),
  Layer.provide(authorizationLayer),
  Layer.provide(ServerAuth.Config.configLayer({ username: Username, password: Option.some("secret") })),
  Layer.provideMerge(NodeHttpServer.layerTest),
)
const built = HttpRouter.toWebHandler(appLayer, { disableLogger: true })
const send = (path: string, headers?: Record<string, string>) =>
  built.handler(new Request(`http://localhost${path}`, { headers }))

const basic = `Basic ${Buffer.from(`${Username}:secret`).toString("base64")}`

describe("pty connect authorization", () => {
  test("the connect route with a ticket skips credential checks", async () => {
    const response = await send(`/api/pty/pty_1/connect?${PTY_CONNECT_TICKET_QUERY}=abc`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ route: "connect" })
  })

  test("the connect route without a ticket still needs credentials", async () => {
    expect((await send("/api/pty/pty_1/connect")).status).toBe(401)
    expect((await send("/api/pty/pty_1/connect", { Authorization: basic })).status).toBe(200)
  })

  test("an empty ticket does not skip credential checks", async () => {
    expect((await send(`/api/pty/pty_1/connect?${PTY_CONNECT_TICKET_QUERY}=`)).status).toBe(401)
  })

  test("a ticket on any other route does not skip credential checks", async () => {
    const response = await send(`/api/pty/pty_1/other?${PTY_CONNECT_TICKET_QUERY}=abc`)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
    expect((await send(`/api/pty/pty_1/other?${PTY_CONNECT_TICKET_QUERY}=abc`, { Authorization: basic })).status).toBe(200)
  })

  test("a connect lookalike path that does not match the route is not exempted", async () => {
    for (const path of ["/api/pty/pty_1/connect/x", "/api/pty/connect", "/api/other/pty_1/connect"]) {
      const response = await send(`${path}?${PTY_CONNECT_TICKET_QUERY}=abc`)
      expect(response.status).not.toBe(200)
    }
  })
})
