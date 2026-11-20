import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "node:fs"
import { Effect } from "effect"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { TrustGate } from "../../src/project/trust-gate"
import { TestInstance, testTmpRoot } from "../fixture/fixture"
import { it, useServerConfig } from "../supervisor/supervisor-test-harness"
import { holdGlobalConfig } from "./global-config"

// K6: a command template can contain a shell snippet (`!`cmd``); session/prompt.ts runs
// it before the model sees the prompt. The template text is config content, so a project
// config is project code. These cases drive the real SessionPrompt service through the
// same harness as the prompt suite; only the trust record differs per case.

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let userProbeDir = ""
let releaseUserProbe: (() => Promise<void>) | undefined

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

// A command in the user-owned config directory. The instance boots and loads the
// global layer before the test body runs, so the file has to exist now. The probe
// directory is file-scoped: the global entry cannot carry a per-test marker path.
beforeAll(async () => {
  userProbeDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6-commands-user-"))
  releaseUserProbe = await holdGlobalConfig({
    command: { userprobe: { template: `Probe: !\`touch ${path.join(userProbeDir, "user-owned")}\`` } },
  })
})

afterAll(async () => {
  await releaseUserProbe?.()
  releaseUserProbe = undefined
  await clean(userProbeDir)
})

beforeEach(async () => {
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k6-commands-"))
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  stderr?.mockRestore()
  await clean(markerDir)
  TrustGate._resetMayRunCache?.()
})

const boot = Effect.fn("trustCommands.boot")(function* () {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create({ title: "trust-commands" })
  return { prompt, chat }
})

const command = (name: string, marker: string) => ({
  [name]: { template: `Probe: !\`touch ${marker}\`` },
})

const deniedWarning = () =>
  (stderr.mock.calls as unknown[][]).some((call) => String(call[0]).includes("outside every trusted root"))

it.instance(
  "a project command's shell snippet does not run in an untrusted project",
  () =>
    Effect.gen(function* () {
      const marker = path.join(markerDir, "project-untrusted")
      const { llm } = yield* useServerConfig({ command: command("probe", marker) })
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.command({ sessionID: chat.id, command: "probe", arguments: "" })

      expect(existsSync(marker)).toBe(false)
      expect(deniedWarning()).toBe(true)
      // The rest of the template still reaches the model; only the snippet is absent.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("Probe:")
    }),
  { trust: false },
  30_000,
)

it.instance(
  "a trusted project's command snippet runs",
  () =>
    Effect.gen(function* () {
      const marker = path.join(markerDir, "project-trusted")
      const { llm } = yield* useServerConfig({ command: command("probe", marker) })
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.command({ sessionID: chat.id, command: "probe", arguments: "" })

      expect(existsSync(marker)).toBe(true)
    }),
  30_000,
)

it.instance(
  "a user-owned command snippet runs in an untrusted project",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig({})
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.command({ sessionID: chat.id, command: "userprobe", arguments: "" })

      expect(existsSync(path.join(userProbeDir, "user-owned"))).toBe(true)
    }),
  { trust: false },
  30_000,
)

it.instance(
  "a markdown project command does not run shell in an untrusted project",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const marker = path.join(markerDir, "markdown-untrusted")
      const file = path.join(directory, ".opencode", "command", "mdprobe.md")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() => Bun.write(file, `Markdown probe: !\`touch ${marker}\`\n`))
      const { llm } = yield* useServerConfig({})
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.command({ sessionID: chat.id, command: "mdprobe", arguments: "" }).pipe(Effect.exit)

      expect(existsSync(marker)).toBe(false)
    }),
  { trust: false },
  30_000,
)
