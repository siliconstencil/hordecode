import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { TrustGate } from "@/project/trust-gate"
import { WorkflowNode } from "@/effect/supervisor-node"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The guest workflow() primitive resolves a child saved workflow from the project
// (workflow/src/runtime.ts:1278). That file is project code, so the runtime must
// consult the trust gate the opencode wiring injects. The runtime, the config
// loader and the trust store are the product's; no gate mock is used.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, InstanceStore.node, Database.node, WorkflowNode]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const childScript = [
  `export const meta = { name: "k3-child", description: "child" }`,
  `return "child-ok"`,
].join("\n")

const parentScript = [
  `export const meta = { name: "k3-parent", description: "parent" }`,
  `return await workflow("k3-child")`,
].join("\n")

const builtinParentScript = [
  `export const meta = { name: "k3-builtin-parent", description: "parent" }`,
  `const result = await workflow("deep-research", { question: "q", today: "2026-11-18", depth: "k3-invalid" })`,
  `return result ?? "child-failed"`,
].join("\n")

const seedFkParents = (sessionID: SessionID, directory: string) =>
  Effect.gen(function* () {
    const projectID = `proj-k3-${path.basename(directory)}`
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run(),
      ),
    )
    yield* Effect.sync(() =>
      StorageDb.use((db: any) =>
        db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: `k3-child-${path.basename(directory)}`,
            directory,
            title: "k3 child workflow",
            version: "0.2.0",
          })
          .onConflictDoNothing()
          .run(),
      ),
    )
  })

const runParent = (sessionID: SessionID, script: string) =>
  Effect.gen(function* () {
    const wf = yield* WorkflowRuntime.Service
    const { runID } = yield* wf.start({ script, sessionID, parentSupervisorID: "main" })
    const outcome = yield* wf.wait({ runID, timeoutMs: 10_000 })
    const structure = yield* wf.structure({ runID })
    return { outcome, structure }
  })

describe("child workflow trust gate", () => {
  it.instance("an untrusted parent workflow cannot load a project child workflow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "workflows"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "workflows", "k3-child.js"), childScript))
      const sessionID = SessionID.descending("ses_k3_child_untrusted")
      yield* seedFkParents(sessionID, dir)

      // The fixture stands in for a trusted boot; forget it to model an untrusted
      // project without mocking the gate.
      yield* Effect.sync(() => TrustGate.forget({ directory: dir, worktree: dir }))

      const { outcome } = yield* runParent(sessionID, parentScript)
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("expected failure")
      expect(outcome.error).toContain("unknown workflow")
    }),
    { git: true },
  )

  it.instance("a trusted parent loads a project child workflow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "workflows"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, ".hordecode", "workflows", "k3-child.js"), childScript))
      const sessionID = SessionID.descending("ses_k3_child_trusted")
      yield* seedFkParents(sessionID, dir)

      const { outcome } = yield* runParent(sessionID, parentScript)
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("expected completion")
      expect(outcome.result).toBe("child-ok")
    }),
    { git: true },
  )

  it.instance("a built-in child still runs in an untrusted project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      yield* Effect.sync(() => TrustGate.forget({ directory: dir, worktree: dir }))
      const sessionID = SessionID.descending("ses_k3_child_builtin")
      yield* seedFkParents(sessionID, dir)

      const { outcome, structure } = yield* runParent(sessionID, builtinParentScript)
      // The built-in ran (its name reaches the child structure); it fails on the
      // deliberately invalid depth before any agent call, and the parent gets null.
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("expected completion")
      expect(outcome.result).toBe("child-failed")
      expect(structure.nodes.some((node) => node.type === "workflow" && node.name === "deep-research")).toBe(true)
    }),
    { git: true },
  )
})
