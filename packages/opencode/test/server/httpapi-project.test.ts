// Real HTTP round-trip coverage for the project HttpApi group.  closes
// the zero-test-invocation gap for the 4 remaining endpoints in
// packages/opencode/src/server/routes/instance/httpapi/groups/project.ts:
//   - GET    /project                       -> list known projects
//   - GET    /project/current               -> current project for the directory
//   - PATCH  /project/:projectID            -> update project name/icon/commands
//   - GET    /project/:projectID/directories -> list known directories for project
//
// initGit is already covered by project-init-git.test.ts; this file is the
// 4-of-5 missing-slot completion.
import { ProjectV2 } from "@opencode-ai/core/project"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Snapshot } from "../../src/snapshot"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testInstanceStore = AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]])
const it = testEffect(
  Layer.mergeAll(AppNodeBuilder.build(LayerNode.group([Project.node, FSUtil.node, Snapshot.node])), testInstanceStore, httpApiLayer),
)

const PROJECT_LIST = "/project"
const PROJECT_CURRENT = "/project/current"
const PROJECT_UPDATE = (id: string) => `/project/${id}`
const PROJECT_DIRECTORIES = (id: string) => `/project/${id}/directories`

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("project HttpApi", () => {
  it.instance("GET /project returns the list of known projects", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* requestInDirectory(PROJECT_LIST, tmp.directory)

      expect(response.status).toBe(200)
      const body = (yield* json<Array<{ id: string; worktree: string; vcs?: string }>>(response))
      expect(Array.isArray(body)).toBe(true)
      // At least one project is reachable for the active instance.
      expect(body.some((p) => p.worktree === tmp.directory || p.id === "global")).toBe(true)
    }),
    { git: true },
  )

  it.instance("GET /project/current returns the current project for the directory", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* requestInDirectory(PROJECT_CURRENT, tmp.directory)

      expect(response.status).toBe(200)
      const body = yield* json<{ id: string; vcs?: string; worktree: string }>(response)
      expect(body.worktree).toBe(tmp.directory)
    }),
    { git: true },
  )

  it.instance("PATCH /project/:id updates the project name and returns the updated row", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      // List the project to discover its real id (the active directory's project
      // is not necessarily stored under id "global" depending on the bootstrap path).
      const listResponse = yield* requestInDirectory(PROJECT_LIST, tmp.directory)
      const projects = yield* json<Array<{ id: string; worktree: string }>>(listResponse)
      const target = projects.find((p) => p.worktree === tmp.directory) ?? projects[0]
      if (!target) return yield* Effect.fail(new Error("no project available to PATCH"))

      const response = yield* requestInDirectory(PROJECT_UPDATE(target.id), tmp.directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "p817-updated" }),
      })

      expect(response.status).toBe(200)
      const body = yield* json<{ id: string; name?: string; worktree: string }>(response)
      expect(body.id).toBe(target.id)
      expect(body.name).toBe("p817-updated")
      expect(body.worktree).toBe(tmp.directory)
    }),
    { git: true },
  )

  it.instance("PATCH /project/:id with an unknown id returns 404", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const unknownID = "proj_does_not_exist" as ProjectV2.ID
      const response = yield* requestInDirectory(PROJECT_UPDATE(unknownID), tmp.directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "should fail" }),
      })

      expect(response.status).toBe(404)
      const body = (yield* json<{ _tag?: string; projectID?: string; message?: string }>(response))
      expect(body._tag).toBe("ProjectNotFoundError")
      expect(body.projectID).toBe(unknownID)
    }),
    { git: true },
  )

  it.instance("GET /project/:id/directories returns the directories known for a project", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* requestInDirectory(PROJECT_DIRECTORIES("global"), tmp.directory)

      expect(response.status).toBe(200)
      const body = yield* json<Array<{ directory: string; strategy?: string }>>(response)
      expect(Array.isArray(body)).toBe(true)
    }),
    { git: true },
  )
})
