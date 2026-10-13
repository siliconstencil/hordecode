import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Bus } from "@opencode-ai/bus"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { Instance } from "@opencode-ai/project/instance"
import { InstanceRef } from "@/effect/instance-ref"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { ChangeDirectoryTool } from "../../src/tool/change-directory"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

// change_directory's execute reads two orthogonal instance channels: the
// opencode InstanceState.context (Effect-side InstanceRef, provided by
// it.instance) AND core SessionCwd's module store whose unset fallback is the
// core Instance AsyncLocalStorage. it.instance only binds the Effect side, so
// every tool invocation here also enters the core ALS for the directory that
// the opencode Effect instance resolves to. Entering it via Instance.provide /
// Instance.restore makes the ALS propagate through the whole (async) execution
// exactly as it does through the CLI/TUI runtime's own instance entry, without
// which SessionCwd.get's fallback throws LocalContext.NotFound. This is the
// same pattern the upstream session-cwd test uses (Instance.provide + directory).
function coreBound<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const ins = yield* InstanceState.context
    // The inner effect runs on a fresh fiber under Effect.runPromise, so it
    // does not inherit the test body's Effect-side InstanceRef. Re-provide it
    // explicitly (same context the outer body resolved) and enter the core
    // ALS for the same directory so SessionCwd's unset fallback resolves to
    // that directory instead of throwing LocalContext.NotFound. Effect.runPromise
    // runs under the current fiber's inherited runtime, so the test layer's
    // services (FSUtil, Bus, ...) remain available across the promise boundary;
    // the env cast to `never` is the type-level acknowledgment of that runtime
    // inheritance the test layer provides.
    const provided = self.pipe(Effect.provideService(InstanceRef, ins)) as Effect.Effect<A, E, never>
    return yield* Effect.promise(() => Instance.restore(ins, () => Effect.runPromise(provided))) as Effect.Effect<A, E, R>
  })
}

const published: Array<{ type: string; properties: unknown }> = []

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(FSUtil.node),
    testInstanceStoreLayer,
    Layer.mock(Bus.Service, {
      publish: (def: { type: string }, properties: unknown) =>
        Effect.sync(() => {
          published.push({ type: def.type, properties })
        }),
      subscribe: () => {
        throw new Error("subscribe not used in change-directory test")
      },
      subscribeAll: () => {
        throw new Error("subscribeAll not used in change-directory test")
      },
      subscribeCallback: () => Effect.succeed(() => {}),
      subscribeAllCallback: () => Effect.succeed(() => {}),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build" } as unknown as Agent.Info),
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
    }),
  ),
)

afterEach(() => {
  published.length = 0
})

function makeCtx(sessionID: string) {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const base: Omit<Tool.Context, "ask"> = {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
  }
  const ctx: Tool.Context = {
    ...base,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

// Raw execute with the core ALS bound (mirrors the runtime contract).
const run = Effect.fn("ChangeDirectoryTest.run")(function* (
  sessionID: string,
  input: { path: string },
  ctx: Tool.Context,
) {
  const info = yield* ChangeDirectoryTool
  const def = yield* info.init()
  return yield* coreBound(def.execute(input, ctx))
})

const failure = Effect.fn("ChangeDirectoryTest.failure")(function* (sessionID: string, input: { path: string }) {
  const { ctx } = makeCtx(sessionID)
  const exit = yield* run(sessionID, input, ctx).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected change_directory to fail")
})

// Read SessionCwd with the core ALS bound so the unset fallback resolves to the
// test instance directory instead of throwing LocalContext.NotFound. The read
// must be deferred (Effect.sync) so it executes inside coreBound's restored ALS
// window, not eagerly in the test body's own (unbound) ALS context.
const readCwd = Effect.fn("ChangeDirectoryTest.readCwd")(function* (sessionID: string) {
  return yield* coreBound(Effect.sync(() => SessionCwd.get(SessionID.make(sessionID))))
})

describe("change_directory tool", () => {
  it.instance("sets the per-session cwd on success", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_success"
      const { ctx } = makeCtx(sessionID)
      const sub = path.join(test.directory, "sub")
      const fs = yield* FSUtil.Service
      yield* fs.ensureDir(sub)

      const result = yield* run(sessionID, { path: "sub" }, ctx)

      expect(result.output).toContain(sub)
      // The exact assertion that would have failed against the old no-op code.
      expect(SessionCwd.get(SessionID.make(sessionID))).toBe(sub)
      const changed = published.filter((p) => p.type === SessionCwd.Event.Changed.type)
      expect(changed).toHaveLength(1)
      expect(changed[0]!.properties).toMatchObject({ sessionID, cwd: sub })
    }),
  )

  it.instance("resolves a later relative path against the new cwd", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_relative"
      const { ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const sub = path.join(test.directory, "sub")
      const nested = path.join(sub, "nested")
      yield* fs.ensureDir(nested)

      yield* run(sessionID, { path: "sub" }, ctx)
      const result = yield* run(sessionID, { path: "nested" }, ctx)

      expect(result.output).toContain(nested)
      expect(SessionCwd.get(SessionID.make(sessionID))).toBe(nested)
    }),
  )

  it.instance("handles absolute paths against the new cwd", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_absolute"
      const { ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const sub = path.join(test.directory, "sub")
      yield* fs.ensureDir(sub)

      const result = yield* run(sessionID, { path: sub }, ctx)

      expect(result.output).toContain(sub)
      expect(SessionCwd.get(SessionID.make(sessionID))).toBe(sub)
    }),
  )

  it.instance("~ resets the cwd back to the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_reset"
      const { ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const sub = path.join(test.directory, "sub")
      yield* fs.ensureDir(sub)

      yield* run(sessionID, { path: "sub" }, ctx)
      expect(SessionCwd.get(SessionID.make(sessionID))).toBe(sub)

      const result = yield* run(sessionID, { path: "~" }, ctx)

      expect(result.output).toContain(test.directory)
      const cleared = yield* readCwd(sessionID)
      expect(cleared).toBe(test.directory)
    }),
  )

  it.instance("empty-string path resets the cwd back to the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_empty"
      const { ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const sub = path.join(test.directory, "sub")
      yield* fs.ensureDir(sub)

      yield* run(sessionID, { path: "sub" }, ctx)
      yield* run(sessionID, { path: "" }, ctx)

      const cleared = yield* readCwd(sessionID)
      expect(cleared).toBe(test.directory)
    }),
  )

  it.instance("asks external_directory when the target is outside the project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_external"
      const { requests, ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const outside = path.join(path.dirname(test.directory), "ppp-s3-outside-cd")
      yield* fs.ensureDir(outside)

      const result = yield* run(sessionID, { path: outside }, ctx)

      expect(result.output).toContain(outside)
      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns.some((p) => p.includes("ppp-s3-outside-cd"))).toBe(true)
    }),
  )

  it.instance("does not ask external_directory for paths inside the project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_internal"
      const { requests, ctx } = makeCtx(sessionID)
      const fs = yield* FSUtil.Service
      const sub = path.join(test.directory, "sub")
      yield* fs.ensureDir(sub)

      yield* run(sessionID, { path: "sub" }, ctx)

      expect(requests.filter((r) => r.permission === "external_directory")).toHaveLength(0)
    }),
  )

  it.instance("fails with a clear error on a missing directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const missing = path.join(test.directory, "does-not-exist")
      const err = yield* failure("ses_cd_missing", { path: missing })
      expect(err.message).toContain(`Directory does not exist: ${missing}`)
    }),
  )

  it.instance("fails with a clear error when the target is not a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = "ses_cd_notdir"
      const file = path.join(test.directory, "file.txt")
      yield* Effect.promise(() => Bun.write(file, "content"))

      const err = yield* failure(sessionID, { path: file })
      expect(err.message).toContain(`Path is not a directory: ${file}`)
    }),
  )
})
