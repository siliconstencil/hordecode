import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { Authorization, authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { ServerAuth } from "@opencode-ai/server/auth"
import "./preload"

const Username = "hordecode"

const PingSuccess = Schema.Struct({ ok: Schema.Boolean })

// A minimal probe API that exercises only the Authorization middleware, so the
// session handler's full core stack is not required. Endpoint paths are absolute.
const ProbeGroup = HttpApiGroup.make("probe")
  .add(HttpApiEndpoint.get("ping", "/ping", { success: PingSuccess }))
  .middleware(Authorization)

const ProbeApi = HttpApi.make("probe-api").add(ProbeGroup)

const ProbeHandler = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ ok: true })),
)

function buildHandler(password: Option.Option<string>) {
  const appLayer = HttpApiBuilder.layer(ProbeApi).pipe(
    Layer.provide(ProbeHandler),
    Layer.provide(authorizationLayer),
    Layer.provide(ServerAuth.Config.configLayer({ username: Username, password })),
    Layer.provideMerge(NodeHttpServer.layerTest),
  )
  const built = HttpRouter.toWebHandler(appLayer, { disableLogger: true })
  return (request: Request) => built.handler(request)
}

function basicHeader(value: string) {
  return `Basic ${Buffer.from(`${Username}:${value}`).toString("base64")}`
}

describe("authorization middleware", () => {
  let handler: (request: Request) => Promise<Response>

  beforeAll(() => {
    handler = buildHandler(Option.some("secret"))
  })

  afterAll(() => {})

  test("no password configured: request without credentials succeeds", async () => {
    const openHandler = buildHandler(Option.none())
    const response = await openHandler(new Request("http://localhost/ping"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("password configured: request without credentials is rejected with 401", async () => {
    const response = await handler(new Request("http://localhost/ping"))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain('Basic realm="Secure Area"')
  })

  test("password configured: valid credentials succeed", async () => {
    const response = await handler(
      new Request("http://localhost/ping", { headers: { Authorization: basicHeader("secret") } }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("password configured: wrong credentials are rejected with 401", async () => {
    const response = await handler(
      new Request("http://localhost/ping", { headers: { Authorization: basicHeader("wrong") } }),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain('Basic realm="Secure Area"')
  })
})
