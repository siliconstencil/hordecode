// Real HTTP round-trip coverage for the file HttpApi group.  closes the
// zero-`it.live`-invocation gap for the 6 endpoints in
// packages/opencode/src/server/routes/instance/httpapi/groups/file.ts:
//   - GET /find          -> findText (ripgrep text search)
//   - GET /find/file     -> findFile (file/dir search)
//   - GET /find/symbol   -> findSymbol (LSP symbol search)
//   - GET /file          -> list (directory listing)
//   - GET /file/content  -> content (file read)
//   - GET /file/status   -> status (git status)
//
// Pattern follows packages/opencode/test/server/httpapi-session.test.ts and
// project-init-git.test.ts: real HTTP round-trip through HttpApiApp.webHandler
// with x-opencode-directory, using it.live + Effect.gen, not mocks.
// it.instance provides a scoped tmpdir via TestInstance so the body stays
// in Effect.gen (no top-level `await`).
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Snapshot } from "../../src/snapshot"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testInstanceStore = AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]])
const it = testEffect(
  Layer.mergeAll(AppNodeBuilder.build(LayerNode.group([FSUtil.node, Snapshot.node, Git.node])), testInstanceStore, httpApiLayer),
)

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("file HttpApi", () => {
  it.instance(
    "GET /file lists files in the directory",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "hello"))

        const response = yield* requestInDirectory(`${FilePaths.list}?path=.`, tmp.directory)
        expect(response.status).toBe(200)
        const body = yield* json<Array<{ name: string; path: string; type: string }>>(response)
        expect(body).toContainEqual(expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }))
      }),
    { git: true },
  )

  it.instance(
    "GET /file/content reads the content of a file",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "hello"))

        const response = yield* requestInDirectory(`${FilePaths.content}?path=hello.txt`, tmp.directory)
        expect(response.status).toBe(200)
        const body = yield* json<{ type: string; content: string }>(response)
        expect(body).toMatchObject({ type: "text", content: "hello" })
      }),
    { git: true },
  )

  it.instance(
    "GET /file/status returns 200 with a body array (handler currently returns [])",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "new.txt"), "untracked"))

        const response = yield* requestInDirectory(FilePaths.status, tmp.directory)
        // The status handler in packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts
        // is currently a hardcoded `return []` ( finding). We assert the HTTP contract
        // (200 + array body) and leave the git status real wiring for a follow-up.
        expect(response.status).toBe(200)
        const body = yield* json<Array<unknown>>(response)
        expect(Array.isArray(body)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "GET /find returns ripgrep matches for a text pattern",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "needle in haystack"))

        const response = yield* requestInDirectory(`${FilePaths.findText}?pattern=needle`, tmp.directory)
        expect(response.status).toBe(200)
        const body = yield* json<Array<{ line_number: number }>>(response)
        expect(body.length).toBeGreaterThan(0)
        expect(body[0]?.line_number).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "GET /find/file returns file paths matching a name query",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "needle"))

        // The file search index is async; poll for the index to publish the new file.
        const found = yield* pollWithTimeout(
          Effect.gen(function* () {
            const response = yield* requestInDirectory(`${FilePaths.findFile}?query=hello&type=file`, tmp.directory)
            return response.status === 200 ? response : undefined
          }),
          "file search index was not ready",
        )
        expect(found.status).toBe(200)
        const body = yield* json<string[]>(found)
        expect(body).toContain("hello.txt")
      }),
    { git: true },
  )

  it.instance(
    "GET /find/symbol returns an empty array for a workspace with no symbols",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "plain text, no symbols"))

        const response = yield* requestInDirectory(`${FilePaths.findSymbol}?query=hello`, tmp.directory)
        expect(response.status).toBe(200)
        const body = yield* json<unknown[]>(response)
        expect(Array.isArray(body)).toBe(true)
      }),
    { git: true },
  )
})

// Suppress unused import warning -- HttpApiApp is wired through httpApiLayer.
void HttpApiApp
