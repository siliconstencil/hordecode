import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { credentialEnvKeys } from "@opencode-ai/core/util/credential-env"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const lspLayer = LayerNode.compile(
  LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(Layer.mergeAll(lspLayer, LayerNode.compile(CrossSpawnSpawner.node)))

const envDumpServer = path.join(__dirname, "../fixture/lsp/env-dump-server.mjs")

const setCredentialEnv = () => {
  // Only the *_AUTH_CONTENT vars: the engine's config loader actively reads
  // *_CONFIG_CONTENT as a JSON config override (config.ts), so poisoning it
  // here would break the LSP layer under test. The strip assertion checks all
  // of credentialEnvKeys() regardless of which are actually present.
  process.env.OPENCODE_AUTH_CONTENT = "fake-secret-auth"
  process.env.HORDECODE_AUTH_CONTENT = "fake-secret-horde-auth"
}

const clearCredentialEnv = () => {
  for (const key of credentialEnvKeys()) {
    delete process.env[key]
  }
}

describe("lsp.ts custom-server spawn credential strip", () => {
  afterEach(() => {
    clearCredentialEnv()
  })

  it.instance(
    "custom LSP server env strips credential keys and keeps item.env extras",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const dir = test.directory
          const dumpPath = path.join(dir, "env-dump.json")

          setCredentialEnv()

          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          // touchFile drives the custom server's spawn closure (lsp.ts), which
          // builds env as `{ ...withoutCredentials(process.env), ...item.env }`
          // before handing it to Process.spawn. The fake server writes that env
          // to dumpPath on startup.
          yield* lsp.touchFile(file)

          const dumped = yield* Effect.promise(() =>
            fs
              .readFile(dumpPath, "utf8")
              .then((raw) => JSON.parse(raw) as { env: NodeJS.ProcessEnv })
              .catch(() => undefined),
          )

          expect(dumped).toBeDefined()
          for (const key of credentialEnvKeys()) {
            expect(dumped!.env).not.toHaveProperty(key)
          }
          // item.env extras must survive the scrub.
          expect(dumped!.env.CUSTOM_ENV).toBe("from-config")
          // Non-credential inherited env must survive.
          expect(dumped!.env.PATH).toBeTypeOf("string")
        }),
      ),
    {
      config: {
        lsp: {
          credstrip: {
            // Relative dump filename resolves against the child's cwd, which is
            // the LSP root (the instance directory): env-dump-server.mjs writes
            // to resolve(argv[2]).
            command: [process.execPath, envDumpServer, "env-dump.json"],
            extensions: [".repro"],
            env: { CUSTOM_ENV: "from-config" },
          },
        },
      },
    },
  )
})
