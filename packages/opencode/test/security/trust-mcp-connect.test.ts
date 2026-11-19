import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Effect, Exit } from "effect"
import { Global } from "@opencode-ai/core/global"
import { MCP } from "../../src/mcp"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"

// K5: the state builder refuses a project MCP entry whose code source is denied, but
// the connect entrance resolves its config again. These tests drive MCP.Service.connect
// (the same service method the HTTP connect handler wraps) so a denied entry cannot be
// started by the TUI toggle or the connect endpoint after the state was built.
// Layout follows trust-loaders.test.ts:
//   trusted  -> code in a directory with a trust record
//   ancestor -> code above every trust record, instance below it
//   user     -> code under the user-owned config directory, instance untrusted

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let bases: string[] = []

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k5-mcp-connect-"))
  process.env.K2_MARKER_DIR = markerDir
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr?.mockRestore()
  delete process.env.K2_MARKER_DIR
  for (const base of bases.splice(0)) await clean(base)
  await Promise.all(
    ["hordecode.json"].map((name) => clean(path.join(Global.Path.config, name))),
  )
  TrustGate._resetMayRunCache?.()
})

async function checkout(name: string) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k5-${name}-`)))
  bases.push(base)
  const repo = path.join(base, "repo")
  await fs.mkdir(repo, { recursive: true })
  const init = Bun.spawnSync(["git", "init", "-q", repo])
  if (init.exitCode !== 0) throw new Error("git init failed")
  Bun.spawnSync(["git", "-C", repo, "config", "commit.gpgsign", "false"])
  Bun.spawnSync(["git", "-C", repo, "config", "user.email", "test@opencode.test"])
  Bun.spawnSync(["git", "-C", repo, "config", "user.name", "Test"])
  Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-q", "-m", "root"])
  const child = path.join(repo, "child")
  await fs.mkdir(child, { recursive: true })
  return { base, repo, child }
}

type Place = "trusted" | "ancestor" | "user"

function layout(place: Place, dirs: { repo: string; child: string; base: string }) {
  if (place === "user") return { code: Global.Path.config, instance: dirs.child, trusted: false }
  if (place === "ancestor") return { code: dirs.repo, instance: dirs.child, trusted: true }
  return { code: dirs.repo, instance: dirs.repo, trusted: true }
}

const writeConfig = (root: string, config: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "hordecode.json"), JSON.stringify(config))
  })

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))

const node = (code: string) => [
  "node",
  "-e",
  `require("fs").writeFileSync(process.env.K2_MARKER_DIR + "/${code}", "ran")`,
]

describe("mcp connect entrance", () => {
  it.live("a denied project mcp entry cannot be connected", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-connect-denied"))
      const where = layout("ancestor", dirs)
      yield* writeConfig(where.code, {
        mcp: { k5mcp: { type: "local", command: node("mcp-connect-denied.txt") } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          // The state builder already refused the entry.
          expect((yield* mcp.status()).k5mcp?.status).toBe("disabled")

          // The connect entrance must refuse with the same typed answer.
          const exit = yield* mcp.connect("k5mcp").pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(MCP.NotFoundError)
          expect(yield* marker("mcp-connect-denied.txt")).toBe(false)
        }),
      )
    }),
  )

  it.live("a trusted project mcp entry can be connected", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-connect-trusted"))
      const where = layout("trusted", dirs)
      yield* writeConfig(where.code, {
        mcp: { k5mcp: { type: "local", command: node("mcp-connect-trusted.txt") } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          yield* mcp.connect("k5mcp")
          yield* pollWithTimeout(markerSoon("mcp-connect-trusted.txt"), "trusted mcp connect never ran").pipe(
            Effect.timeout("10 seconds"),
          )
          expect(yield* marker("mcp-connect-trusted.txt")).toBe(true)
        }),
      )
    }),
  )

  it.live("a user-owned mcp entry can be connected in an untrusted project", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.promise(() => checkout("mcp-connect-user"))
      const where = layout("user", dirs)
      yield* writeConfig(where.code, {
        mcp: { k5mcp: { type: "local", command: node("mcp-connect-user.txt") } },
      })

      yield* inside(where.instance, where.trusted, () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          yield* mcp.connect("k5mcp")
          yield* pollWithTimeout(markerSoon("mcp-connect-user.txt"), "user-owned mcp connect never ran").pipe(
            Effect.timeout("10 seconds"),
          )
          expect(yield* marker("mcp-connect-user.txt")).toBe(true)
        }),
      )
    }),
  )
})
