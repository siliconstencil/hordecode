import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { TrustGate } from "../../src/project/trust-gate"
import { InstanceStore } from "../../src/project/instance-store"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { bootLayer, markerExists } from "./harness"

// The memo defaults and the --mini entry. allowed() must deny when the booted
// instance recorded no decision, and the decision must be looked up for the worktree
// root a subdirectory resolves to - the cwd fallback in effect/instance-state.ts:17-38
// supplies a context that has no key of its own. runMini calls the run handler with a
// constructed args object, so its gate entry is miniGate + the same InstanceStore boot
// the handler performs. The trust store and the config loader are the product's.

const installs: Install[] = []
const it = testEffect(bootLayer(installs))

let stderr: ReturnType<typeof spyOn>

beforeEach(() => {
  installs.length = 0
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  stderr.mockRestore()
})

const boot = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    yield* Effect.addFinalizer(() => store.dispose(ctx))
    return ctx
  })

const inside = <A, E, R>(directory: string, body: () => Effect.Effect<A, E, R>) =>
  InstanceStore.Service.use((store) => store.provide({ directory }, Effect.suspend(body)))

const project = (config?: unknown) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    if (config !== undefined) {
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), JSON.stringify(config)))
    }
    return dir
  })

describe("trust memo and the mini entry", () => {
  // K5: N4. The plain fixture path records the deny; it does not leave the memo
  // empty and let allowed() fall through to the store. Drives the no-op-bootstrap
  // store, so nothing but the fixture writes the decision.
  it.live("the plain instance fixture records a deny", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      yield* Effect.addFinalizer(() => Effect.sync(() => TrustGate.forget({ directory: dir, worktree: dir })))
      const check = Effect.suspend(() => Effect.void).pipe(
        provideInstance(dir),
        Effect.provide(testInstanceStoreLayer),
      )
      yield* check

      expect(TrustGate._decision({ directory: dir, worktree: dir })).toBe("untrusted")
    }),
  )

  it.live("allowed fails closed without a decision", () =>
    Effect.gen(function* () {
      const dir = yield* project()

      // No instance booted for this directory: no decision was recorded.
      const allowed = yield* Effect.promise(() => TrustGate.allowed({ directory: dir, worktree: dir }))
      expect(allowed).toBe(false)
    }),
  )

  it.live("a subdirectory of a trusted worktree is allowed", () =>
    Effect.gen(function* () {
      const root = yield* project()
      const subdir = path.join(root, "packages", "nested")
      yield* Effect.promise(() => fs.mkdir(subdir, { recursive: true }))
      yield* Effect.promise(() => TrustGate.trust(root))
      yield* boot(root)

      // A lazy loader that only knows the opened subdirectory (cwd fallback) must
      // resolve the worktree root the instance booted and read its decision.
      const allowed = yield* Effect.promise(() => TrustGate.allowed({ directory: subdir, worktree: subdir }))
      expect(allowed).toBe(true)
    }),
  )

  it.live("a subdirectory of an untrusted worktree is not", () =>
    Effect.gen(function* () {
      const root = yield* project()
      const subdir = path.join(root, "packages", "nested")
      yield* Effect.promise(() => fs.mkdir(subdir, { recursive: true }))
      yield* boot(root)

      const allowed = yield* Effect.promise(() => TrustGate.allowed({ directory: subdir, worktree: subdir }))
      expect(allowed).toBe(false)
    }),
  )

  it.live("run --mini in an untrusted project writes no schema or plugin install", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const configDir = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "hordecode.json"), "{\n  \"username\": \"k3\"\n}\n"))
      yield* Effect.promise(() => Bun.write(path.join(configDir, "hordecode.json"), "{\n  \"username\": \"k3\"\n}\n"))

      // The same directory runMini resolves and hands to the effectCmd boot.
      const { miniGate } = yield* Effect.promise(() => import("../../src/cli/cmd/run"))
      expect(yield* Effect.promise(() => miniGate({ directory: dir }))).toBe(dir)
      yield* inside(dir, () => Effect.void)
      yield* pollWithTimeout(
        Effect.sync(() => installs.find((item) => item.dir === Global.Path.config)),
        "global dependency install never started",
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "hordecode.json")).text())).not.toContain("$schema")
      expect(yield* Effect.promise(() => Bun.file(path.join(configDir, "hordecode.json")).text())).not.toContain(
        "$schema",
      )
      expect(installs.some((item) => item.dir === configDir || item.dir === dir)).toBe(false)
      for (const name of ["node_modules", "package.json", "package-lock.json", ".gitignore"]) {
        expect(yield* Effect.promise(() => markerExists(configDir, name))).toBe(false)
      }
    }),
  )

  it.live("run --mini --trust writes them", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const configDir = path.join(dir, ".hordecode")
      yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(configDir, "hordecode.json"), "{\n  \"username\": \"k3\"\n}\n"))

      const { miniGate } = yield* Effect.promise(() => import("../../src/cli/cmd/run"))
      expect(yield* Effect.promise(() => miniGate({ directory: dir, trust: true }))).toBe(dir)
      yield* inside(dir, () => Effect.void)
      yield* pollWithTimeout(
        Effect.sync(() => installs.find((item) => item.dir === configDir)),
        "project dependency install never started",
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(configDir, "hordecode.json")).text())).toContain("$schema")
      expect(installs.some((item) => item.dir === configDir)).toBe(true)
      for (const name of ["node_modules", "package.json", "package-lock.json", ".gitignore"]) {
        expect(yield* Effect.promise(() => markerExists(configDir, name))).toBe(true)
      }
    }),
  )
})
