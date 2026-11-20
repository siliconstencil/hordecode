import { Effect } from "effect"
import { InstanceStore } from "../../../src/project/instance-store"
import { Plugin } from "../../../src/plugin"
import { lazyLayer, type Install } from "../harness"

// Standalone boot used by trust-env-config.test.ts. It runs in its own process so
// HORDECODE_CONFIG / HORDECODE_CONFIG_DIR are read at module load and the isolated
// HORDECODE_HOME/XDG paths in the environment are the ones the product uses.
// The bootstrap skips plugin init for an untrusted project, so this drives the lazy
// plugin load site (Plugin.init) the same way a tool/LSP load would.
const directory = process.argv[2]
if (!directory) throw new Error("missing directory argument")

const installs: Install[] = []
const layer = lazyLayer(installs)

Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.init()
      }),
    )
  }).pipe(Effect.provide(layer), Effect.scoped),
)
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
