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

      expect(worktree).toEqual({ status: "written", worktree: dir })
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

  // K3: --trust reports and exits on the real write outcome, not on the attempt.
  it.live("--trust prints trusted only when the record was written", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const log = spyOn(console, "log").mockImplementation(() => {})
      try {
        const first = yield* Effect.promise(() => TrustGate.trustDirectory(dir))
        const second = yield* Effect.promise(() => TrustGate.trustDirectory(dir))

        expect(first).toEqual({ status: "written", worktree: dir })
        expect(second).toEqual({ status: "already", worktree: dir })
        const trustedLines = log.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .filter((line: string) => line === `trusted project ${dir}`)
        expect(trustedLines).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    }),
  )

  it.live(
    "--trust on a refused path exits non-zero with one line",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(() =>
          fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP || "/tmp", "k3-cli-refused-")),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(home, { recursive: true, force: true })))

        const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), "run", "--trust", "hello"], {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            HORDECODE_HOME: home,
            XDG_CONFIG_HOME: path.join(home, "xdg", "config"),
            XDG_DATA_HOME: path.join(home, "xdg", "data"),
            XDG_CACHE_HOME: path.join(home, "xdg", "cache"),
            XDG_STATE_HOME: path.join(home, "xdg", "state"),
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = yield* Effect.promise(() =>
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        )

        const refused = stderr.split("\n").filter((line) => line.includes("refused to trust"))
        expect(code).not.toBe(0)
        expect(refused).toHaveLength(1)
        expect(refused[0]).toContain(home)
        expect(stdout).not.toContain("trusted project")
      }),
    30000,
  )
})
