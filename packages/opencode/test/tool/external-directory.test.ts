import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HarnessEnv } from "@opencode-ai/core/session/harness-env"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("does NOT ask for paths under the app-managed worktree base", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      // A child isolated into <data>/worktree/<projectID>/<name> whose Instance is
      // bound to the main checkout (or fell back to shared on a failed boot) sees
      // the worktree as external. Trusting the app-managed base prevents the
      // external_directory ask that would deadlock a background child.
      const wtTarget = path.join(
        Global.Path.data,
        "worktree",
        "21e0df6f-0ff7-4b4e-9f19-9bf7d7f64ba1",
        "peer-relay",
        "packages",
        "opencode",
        "src",
        "tool",
        "session.ts",
      )

      yield* assertExternalDirectoryEffect(ctx, wtTarget)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("still asks for a foreign path that merely resembles the worktree base name (regression)", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      // A user path NOT under <data>/worktree must still prompt: the trust is
      // scoped to the app-managed base, it does not broadly weaken external_directory.
      yield* assertExternalDirectoryEffect(ctx, "/tmp/worktree/foreign/file.txt")

      expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})

describe("tool.assertExternalDirectory harness evidence", () => {
  const evidence = path.join(Global.Path.state, "harness-evidence", "abc123")

  it.instance("the evidence dir of a harness session is granted without an ask, nothing else is", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_harness_evidence")
      HarnessEnv.set(sessionID, { HORDECODE_HARNESS_DOCS: "/abs/docs", HORDECODE_HARNESS_EVIDENCE: evidence })
      const { requests, ctx } = makeCtx()
      const harness = { ...ctx, sessionID }

      yield* assertExternalDirectoryEffect(harness, path.join(evidence, "run-1", "verify.evidence"))
      yield* assertExternalDirectoryEffect(harness, evidence, { kind: "directory" })
      expect(requests.length).toBe(0)

      // Siblings of the evidence dir and look-alike prefixes still ask.
      yield* assertExternalDirectoryEffect(harness, path.join(Global.Path.state, "harness-evidence", "other", "x.evidence"))
      yield* assertExternalDirectoryEffect(harness, evidence + "-evil/x.evidence")
      yield* assertExternalDirectoryEffect(harness, path.join(Global.Path.state, "auth.json"))
      expect(requests.length).toBe(3)
    }),
  )

  it.instance("a session without a harness mapping still asks for the same path", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()
      yield* assertExternalDirectoryEffect({ ...ctx, sessionID: SessionID.make("ses_not_harness_2") }, path.join(evidence, "run-1", "x.evidence"))
      expect(requests.length).toBe(1)
    }),
  )

  it.instance("a child session of the harness session inherits the grant", () =>
    Effect.gen(function* () {
      const parent = SessionID.make("ses_harness_parent_ed")
      const child = SessionID.make("ses_harness_child_ed")
      HarnessEnv.set(parent, { HORDECODE_HARNESS_DOCS: "/abs/docs", HORDECODE_HARNESS_EVIDENCE: evidence })
      HarnessEnv.inherit(parent, child)
      const { requests, ctx } = makeCtx()
      yield* assertExternalDirectoryEffect({ ...ctx, sessionID: child }, path.join(evidence, "run-2", "x.evidence"))
      expect(requests.length).toBe(0)
    }),
  )
})
