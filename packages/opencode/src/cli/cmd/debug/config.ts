import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { redactConfig } from "./redact"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    process.stdout.write(JSON.stringify(redactConfig(config), null, 2) + EOL)
    // Stderr keeps stdout as pure JSON. Fork addition, see config/unknown-keys.ts.
    const { listUnknownConfigKeys } = yield* Effect.promise(() => import("@/config/unknown-keys"))
    const unknown = listUnknownConfigKeys()
    if (unknown.length === 0) return
    const lines = unknown.map((key) => {
      const hint = key.suggestion ? ` (did you mean "${key.suggestion}"?)` : ""
      return `  ${key.path}${hint} in ${key.source}`
    })
    process.stderr.write(["Unknown config keys:", ...lines].join(EOL) + EOL)
  }),
})
