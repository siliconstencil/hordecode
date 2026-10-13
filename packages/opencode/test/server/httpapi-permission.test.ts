// Real HTTP round-trip coverage for the permission HttpApi group.  closes
// the zero-test-invocation gap for the 2 endpoints in
// packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts:
//   - GET  /permission              -> list pending permission asks
//   - POST /permission/:id/reply    -> reply once/always/reject
//
// The test drives the real ask service to insert pending entries, then verifies
// the HTTP surface returns them and that the reply path either succeeds or
// surfaces a typed NotFoundError for unknown IDs.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "@opencode-ai/schema/session-id"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, afterEach } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { filesystem, path as pathNode } from "@opencode-ai/core/effect/app-node-platform"
import { Permission } from "../../src/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { requestInDirectory } from "./httpapi-layer"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    EventV2Bridge.node,
    EventV2.node,
    Database.node,
    CrossSpawnSpawner.node,
    filesystem,
    pathNode,
    InstanceStore.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiServerLayer))

const PERMISSION_LIST = "/permission"
const PERMISSION_REPLY = (id: string) => `/permission/${id}/reply`

const baseAsk = (sessionID: SessionID): PermissionV1.AskInput => ({
  id: PermissionV1.ID.ascending(),
  sessionID,
  permission: "bash",
  patterns: ["*"],
  ruleset: [],
  metadata: {},
  always: [],
  interactive: true,
})

afterEach(async () => {
  await resetDatabase()
})

describe("permission HttpApi", () => {
  it.live("GET /permission returns an empty array when no pending asks exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(PERMISSION_LIST, dir)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("GET /permission returns pending asks created via the ask service", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = `ses_perm_list_${Date.now()}` as SessionID
      const id = PermissionV1.ID.ascending()
      const ask = { ...baseAsk(sessionID), id }

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          yield* permission.ask(ask).pipe(Effect.forkScoped)
        }),
      )

      const response = yield* requestInDirectory(PERMISSION_LIST, dir)

      expect(response.status).toBe(200)
      const body = (yield* response.json) as Array<{ id: string; permission: string; sessionID: string }>
      expect(body.length).toBe(1)
      expect(body[0]?.id).toBe(id)
      expect(body[0]?.permission).toBe("bash")
      expect(body[0]?.sessionID).toBe(sessionID)
    }),
  )

  it.live("POST /permission/:id/reply resolves a pending ask and returns true", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = `ses_perm_reply_${Date.now()}` as SessionID
      const id = PermissionV1.ID.ascending()
      const ask = { ...baseAsk(sessionID), id }

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          yield* permission.ask(ask).pipe(Effect.forkScoped)
        }),
      )

      const path = PERMISSION_REPLY(id)
      const response = yield* requestInDirectory(path, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
    }),
  )

  it.live("POST /permission/:id/reply returns 404 for an unknown requestID", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const unknownID = PermissionV1.ID.ascending()
      const path = PERMISSION_REPLY(unknownID)

      const response = yield* requestInDirectory(path, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: "reject", message: "no" }),
      })

      expect(response.status).toBe(404)
      const body = (yield* response.json) as { _tag?: string; requestID?: string; message?: string }
      expect(body._tag).toBe("PermissionNotFoundError")
      expect(body.requestID).toBe(unknownID)
      expect(body.message).toContain(unknownID)
    }),
  )
})
