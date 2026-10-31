import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// A changed global config disposes every instance, which interrupts running turns. The handler defers
// the disposal until the status events on the global bus show no busy session.
const disposed = Ref.makeUnsafe(0)
const layer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(
    Layer.mock(Config.Service)({
      updateGlobal: () => Effect.succeed({ info: {}, changed: true }) as never,
    }),
  ),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(Layer.mock(InstanceStore.Service)({ disposeAll: () => Ref.update(disposed, (n) => n + 1) })),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(layer)

const status = (sessionID: string, type: "busy" | "idle", directory = "/work/a") =>
  GlobalBus.emit("event", { directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } })

// The busy set is process-wide and fed by every instance, so start each test from the state a
// global disposal leaves behind.
const reset = Effect.sync(() => GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } }))

const patch = HttpClientRequest.patch(GlobalPaths.config).pipe(
  HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
  HttpClient.execute,
)

const waitFor = (check: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 100 })) {
      if (yield* check()) return true
      yield* Effect.sleep("20 millis")
    }
    return false
  })

describe("global config update disposal", () => {
  it.live("disposes at once when no session is busy", () =>
    Effect.gen(function* () {
      yield* reset
      yield* Ref.set(disposed, 0)
      expect((yield* patch).status).toBe(200)

      expect(yield* waitFor(() => Ref.get(disposed).pipe(Effect.map((n) => n === 1)))).toBe(true)
    }),
  )

  it.live("waits for the busy session to go idle, then disposes once", () =>
    Effect.gen(function* () {
      yield* reset
      yield* Ref.set(disposed, 0)
      status("ses_busy", "busy")

      expect((yield* patch).status).toBe(200)
      expect((yield* patch).status).toBe(200)
      yield* Effect.sleep("300 millis")
      expect(yield* Ref.get(disposed)).toBe(0)

      status("ses_busy", "idle")
      expect(yield* waitFor(() => Ref.get(disposed).pipe(Effect.map((n) => n >= 1)))).toBe(true)
    }),
  )

  it.live("an instance disposed while busy no longer blocks the disposal", () =>
    Effect.gen(function* () {
      yield* reset
      yield* Ref.set(disposed, 0)
      status("ses_gone", "busy", "/work/gone")

      expect((yield* patch).status).toBe(200)
      yield* Effect.sleep("200 millis")
      expect(yield* Ref.get(disposed)).toBe(0)

      GlobalBus.emit("event", {
        directory: "/work/gone",
        payload: { type: "server.instance.disposed", properties: { directory: "/work/gone" } },
      })
      expect(yield* waitFor(() => Ref.get(disposed).pipe(Effect.map((n) => n >= 1)))).toBe(true)
    }),
  )
})
