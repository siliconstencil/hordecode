import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import os from "os"
import { Duration, Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"
import { Memory } from "@opencode-ai/memory"
import { Service as EmbeddingService } from "@opencode-ai/memory/embedding/service"

export const DebugCommand = cmd({
  command: "debug",
  describe: "debugging and troubleshooting tools",
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .command(WaitCommand)
      .command(EmbeddingCheckCommand)
      .demandCommand(),
  async handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: "wait indefinitely (for debugging)",
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

const InfoCommand = effectCmd({
  command: "info",
  describe: "show debug information",
  handler: Effect.fn("Cli.debug.info")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { ConfigPlugin } = yield* Effect.promise(() => import("@/config/plugin"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const termProgram = process.env.TERM_PROGRAM
      ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
      : undefined
    const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

    console.log(`hordecode version: ${InstallationVersion}`)
    console.log(`os: ${os.type()} ${os.release()} ${os.arch()}`)
    console.log(`terminal: ${terminal || "unknown"}`)
    console.log("plugins:")
    if (Flag.HORDECODE_PURE || Flag.OPENCODE_PURE) {
      console.log("external plugins disabled (--pure)")
      return
    }
    if (!config.plugin_origins?.length) {
      console.log("none")
      return
    }
    for (const plugin of config.plugin_origins) {
      console.log(`- ${ConfigPlugin.pluginSpecifier(plugin.spec)}`)
    }
  }),
})

const EmbeddingCheckCommand = effectCmd({
  command: "embedding-check",
  describe: "verify memory embedding pipeline in compiled binary",
  instance: false,
  handler: Effect.fn("Cli.debug.embedding-check")(function* () {
    console.error("[embedding-check] starting")
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const svc = yield* Config.Service
    const config = yield* svc.get()
    const body = Effect.gen(function* () {
      const embedding = yield* EmbeddingService
      const memory = yield* Memory.Service
      const cfg = config as unknown as { memory?: { embedding?: boolean } }
      const enabled = cfg.memory?.embedding === true

      // Disabled path: gate is off. NOT a failure -- the feature is opt-in.
      if (!enabled) {
        const result = { available: false, state: "disabled" as const }
        console.error("[embedding-check] DISABLED (memory.embedding is false)")
        console.log(JSON.stringify(result))
        return
      }

      // Enabled path: kick off the background init fiber (set up in embedding issue) by
      // calling available() once, then poll the EmbeddingService.state
      // accessor until it is 'ready' or 'unavailable' or 120s elapse.
      // Without this poll, the handler exited before the background fiber
      // ever ran tryInit, so available was always false on a cold cache
      // and no model was downloaded (two cold runs, 1.5s each, 0 bytes).
      const startMs = Date.now()
      yield* embedding.available.pipe(Effect.orDie)
      let last = ""
      let state = (yield* embedding.state.pipe(Effect.orDie)) as
        | "idle"
        | "loading"
        | "ready"
        | "unavailable"
      while (state === "loading" || state === "idle") {
        if (state !== last) {
          console.error(`[embedding-check] state ${state} ${Math.round((Date.now() - startMs) / 1000)}s`)
          last = state
        }
        const elapsed = Date.now() - startMs
        if (elapsed >= 120_000) {
          console.error(`[embedding-check] TIMEOUT after ${Math.round(elapsed / 1000)}s in state ${state}`)
          break
        }
        yield* Effect.sleep(Duration.millis(500))
        state = (yield* embedding.state.pipe(Effect.orDie)) as typeof state
      }
      const elapsedMs = Date.now() - startMs
      console.error(`[embedding-check] final state ${state} ${Math.round(elapsedMs / 1000)}s`)

      const available = yield* embedding.available.pipe(Effect.orDie)
      console.error("[embedding-check] available", available)
      let dim = 0
      if (state === "ready" && available) {
        const vec = yield* embedding.embed("hello world test embedding").pipe(Effect.orDie)
        dim = vec.length
        console.error("[embedding-check] embed dim", dim)
      }
      const addRes = yield* memory.add({ scope: "global", type: "test", body: `embedding-check ${Date.now()} hello` }).pipe(Effect.orDie)
      console.error("[embedding-check] memory_add id", addRes.id)
      const status = yield* memory.status()
      console.error("[embedding-check] status", JSON.stringify(status))
      const result = {
        available,
        state,
        model: status.embeddingModel,
        elapsedMs,
        dim,
        id: addRes.id,
        vectorCount: status.vectorCount,
      }
      console.log(JSON.stringify(result))
      if (state === "unavailable" || dim === 0) {
        console.error("[embedding-check] FAILED")
        process.exitCode = 1
      } else console.error("[embedding-check] PASSED")
    })
    // This command is `instance: false`, so nothing else joins the config-directory
    // dependency install that Config starts as a detached fiber. Join it on every exit
    // path (plugin/index.ts does the same before loading plugins); otherwise the process
    // ends holding the npm-install lock and the next boot waits for it to go stale.
    yield* body.pipe(Effect.ensuring(svc.waitForDependencies()))
  }),
})

const PathsCommand = cmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  handler() {
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), value)
    }
  },
})
