import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { checkTrust, listTrusted, markTrusted } from "@opencode-ai/project/workspace-trust"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { bootLayer, markerExists, pluginFile } from "./harness"

// The CLI wiring is a yargs handler that then boots through InstanceStore.provide;
// the handler itself needs a terminal and a model, so these tests drive the two
// boundaries it uses: the shared store (trustDirectory, the same call effectCmd makes
// before store.load) and the instance boot the run path performs. The trust store is
// the real one.

const installs: Install[] = []
const it = testEffect(bootLayer(installs))

let stderr: ReturnType<typeof spyOn>
let markerDir = ""

beforeEach(async () => {
  installs.length = 0
  markerDir = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || "/tmp", "k2-cli-"))
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr.mockRestore()
  delete process.env.K2_MARKER_DIR
  await fs.rm(markerDir, { recursive: true, force: true })
})

const project = () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(() => fs.mkdir(path.join(dir, ".hordecode", "plugin"), { recursive: true }))
    yield* Effect.promise(() =>
      Bun.write(path.join(dir, ".hordecode", "plugin", "marker.ts"), pluginFile("cli-plugin.txt")),
    )
    return dir
  })

const inside = (directory: string, body: () => Effect.Effect<void>) =>
  Effect.suspend(body).pipe(provideInstance(directory))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))

const warnings = () =>
  stderr.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("is not trusted"))

describe("non-interactive project trust", () => {
  it.live("run without --trust in an untrusted project warns once and runs no project code", () =>
    Effect.gen(function* () {
      const dir = yield* project()

      // InstanceStore.provide is the boot boundary effectCmd hands the run handler.
      yield* inside(dir, () => Effect.void)

      expect(yield* marker("cli-plugin.txt")).toBe(false)
      expect(warnings().length).toBe(1)
      expect(warnings()[0]).toContain(dir)
      expect(warnings()[0]).toContain("--trust")

      // A second ask for the same worktree does not print again.
      yield* Effect.sync(() => TrustGate.warnOnce({ directory: dir, worktree: dir }))
      expect(warnings().length).toBe(1)
    }),
  )

  it.live("run --trust records the project in the shared store", () =>
    Effect.gen(function* () {
      const dir = yield* project()
      const log = spyOn(console, "log").mockImplementation(() => {})

      // The exact call effectCmd makes for --trust before store.load.
      const worktree = yield* Effect.promise(() => TrustGate.trustDirectory(dir))

      expect(worktree).toBe(dir)
      expect(yield* Effect.promise(() => checkTrust(dir))).toBe("trusted")
      expect((yield* Effect.promise(() => listTrusted())).filter((entry) => entry === dir).length).toBe(1)
      expect(log.mock.calls.map((call) => String(call[0]))).toContain(`trusted project ${dir}`)
      log.mockRestore()

      // The recorded trust reaches the boot gate: project code now loads.
      yield* inside(dir, () => Effect.void)
      expect(yield* marker("cli-plugin.txt")).toBe(true)
    }),
  )

  it.live("the TUI gate and the CLI gate read one record", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      // The TUI prompt writes through markTrusted (cli/cmd/tui.ts ensureWorkspaceTrusted).
      yield* Effect.promise(() => markTrusted(dir))

      expect(yield* Effect.promise(() => checkTrust(dir))).toBe("trusted")
      expect(yield* Effect.promise(() => TrustGate.level({ directory: dir, worktree: dir }))).toBe("trusted")
      expect((yield* Effect.promise(() => listTrusted())).filter((entry) => entry === dir).length).toBe(1)

      // One file, one entry: no second store was introduced.
      const store = path.join(Global.Path.data, "trusted-workspaces.json")
      const parsed = JSON.parse(yield* Effect.promise(() => Bun.file(store).text())) as { trustedPaths: string[] }
      expect(parsed.trustedPaths.filter((entry) => entry === dir).length).toBe(1)
    }),
  )
})
