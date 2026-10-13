import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session as SessionNs } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { httpApiLayer } from "./httpapi-layer"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Regression test for the  item-1 workflow routes (list / resume / transcript /
// structure). The workflow runtime is NOT running in the test process (workflowRef is
// null), so every route must degrade to its documented empty/refused shape instead of
// 500, and traversal-shaped runIDs must be rejected with 400 before touching any
// runtime state. The TUI's four workflow helpers (packages/tui/src/context/sync.tsx
// loadWorkflows/resumeWorkflow/loadWorkflowTranscript/loadWorkflowStructure) call
// exactly these sdk.client.workflow.* methods, so this suite is their regression net.

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

type Sdk = ReturnType<typeof createOpencodeClient>
type SdkResult = { response: Response; data?: unknown; error?: unknown }

function client(directory?: string) {
  return serverFetch().pipe(
    Effect.map((fetch) =>
      createOpencodeClient({
        baseUrl: "http://localhost",
        directory,
        fetch,
      }),
    ),
  )
}

function serverFetch() {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response.status,
      data: result.data,
      error: result.error,
    })),
  )
}

function withProject<A, E>(run: (input: { sdk: Sdk; directory: string }) => Effect.Effect<A, E, Scope.Scope | HttpServer.HttpServer>) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      git: false,
      config: { formatter: false, lsp: false },
    })
    return yield* run({ sdk: yield* client(directory), directory })
  })
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  await disposeAllInstances()
})

// Identifier mints "ses_" + 26 base62; "wf_" + 26 base62 for top-level runs, and
// "wf_" + 64 hex for nested child workflows (see groups/workflow.ts READ_RUN_ID).
const VALID_SESSION_ID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
const VALID_RUN_ID = "wf_AbCdEfGhIjKlMnOpQrStUvWxYz"
const CHILD_RUN_ID = `wf_${"ab".repeat(32)}`
const TRAVERSAL_RUN_ID = "wf_../../../etc/passwd"

describe("Workflow HttpApi", () => {
  it.live("lists workflow runs for a valid sessionID, empty when runtime is down", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.list({ sessionID: VALID_SESSION_ID }))
      expect(result.status).toBe(200)
      expect(result.data).toEqual([])
    }),
  ))

  it.live("rejects list requests with an invalid sessionID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.list({ sessionID: "bad" }))
      expect(result.status).toBe(400)
    }),
  ))

  it.live("rejects list requests with an omitted sessionID", withProject(({ directory }) =>
    Effect.gen(function* () {
      const fetch = yield* serverFetch()
      const res = yield* call(() =>
        fetch("http://localhost/workflows", {
          headers: { "x-opencode-directory": encodeURIComponent(directory) },
        }),
      )
      expect(res.status).toBe(400)
    }),
  ))

  it.live("refuses resume for an unknown run when runtime is down", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.resume({ runID: VALID_RUN_ID }))
      expect(result.status).toBe(200)
      expect(result.data).toEqual({ runID: VALID_RUN_ID, resumed: false })
    }),
  ))

  it.live("rejects resume with a traversal-shaped runID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.resume({ runID: TRAVERSAL_RUN_ID }))
      expect(result.status).toBe(400)
    }),
  ))

  it.live("returns an empty transcript for a valid top-level runID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.transcript({ runID: VALID_RUN_ID }))
      expect(result.status).toBe(200)
      expect(result.data).toEqual({ runID: VALID_RUN_ID, transcript: [] })
    }),
  ))

  it.live("accepts the nested child-workflow 64-hex runID shape", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.transcript({ runID: CHILD_RUN_ID }))
      expect(result.status).toBe(200)
      expect(result.data).toEqual({ runID: CHILD_RUN_ID, transcript: [] })
    }),
  ))

  it.live("rejects transcript with an invalid runID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.transcript({ runID: "wf_nope" }))
      expect(result.status).toBe(400)
    }),
  ))

  it.live("returns an empty structure tree for a valid runID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.structure({ runID: VALID_RUN_ID }))
      expect(result.status).toBe(200)
      expect(result.data).toEqual({ runID: VALID_RUN_ID, nodes: [] })
    }),
  ))

  it.live("rejects structure with an invalid runID", withProject(({ sdk }) =>
    Effect.gen(function* () {
      const result = yield* capture(() => sdk.workflow.structure({ runID: "wf_nope" }))
      expect(result.status).toBe(400)
    }),
  ))
})
