// The fork session twin (packages/core/src/session/prompt.ts) is the loop the
// supervisor spawns (packages/supervisor/src/spawn.ts:6 imports it as
// SessionPrompt). It must honour the same global `steps` config key as the
// main loop (packages/opencode/src/session/prompt.ts): spawn steps (hard) >
// agent steps (soft) > global steps (soft) > the twin's own fallback.
//
// The two SessionPrompt services sit on distinct service tags (see
// test/session/prompt-tag.test.ts), so the main loop's harness does not mount
// the twin. The twin's chain is asserted against its source. The config side
// is asserted on the CORE config module, because that is the service the twin
// reads: the twin takes `Config.Service` (packages/core/src/session/prompt.ts:355)
// and its own layer provides the core config service
// (packages/core/src/session/prompt.ts:3228).
//
// The core config SERVICE is not mounted here: it carries the same
// "@opencode/Config" tag as the app config service
// (packages/opencode/src/config/config.ts:144), it needs the core instance
// context, and its load path reads the real global config directory
// (packages/core/src/config/config.ts:717) and seeds a starter file there when
// none exists (packages/core/src/config/config.ts:742-750). The core load path's
// own parse functions are asserted instead, on a payload shaped like the
// global config file.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { Config as CoreConfig, ConfigParse } from "@opencode-ai/core/config/index"
import { it, useServerConfig } from "../supervisor/supervisor-test-harness"

const twinSource = await Bun.file(path.join(import.meta.dir, "../../../core/src/session/prompt.ts")).text()

// Only the step-budget lines, so a failed assertion does not print the whole
// twin source.
const twinStepBudget = twinSource
  .split("\n")
  .filter((line) => line.includes("maxSteps") || line.includes("globalSteps"))
  .map((line) => line.trim())

describe("fork session twin", () => {
  test("reads the global step limit from the config service it already uses", () => {
    expect(
      twinStepBudget,
      "the twin must read the global `steps` key from its own config service",
    ).toContain("const globalSteps = (yield* config.get()).steps")
  })

  test("keeps the spawn, agent, global and fallback precedence of the main loop", () => {
    expect(
      twinStepBudget,
      "the twin must resolve the step budget as spawn > agent > global > its own fallback",
    ).toContain("const maxSteps = steps ?? agent.steps ?? globalSteps ?? Infinity")
  })

  test("the config schema the twin's service parses with keeps the global step limit", () => {
    expect(
      CoreConfig.Info.parse({ steps: 7 }).steps,
      "the core config schema must accept the root level `steps` key",
    ).toBe(7)
  })

  test("the core config load path accepts a global config file that carries `steps`", () => {
    // The core config service loads the global file with these two functions
    // (packages/core/src/config/config.ts:685-686). The schema is strict
    // (packages/core/src/config/config.ts:567), so a global file that carries
    // the global `steps` key has to survive the parse, otherwise the twin's
    // config load fails once the key exists in that file.
    const parsed = ConfigParse.jsonc(JSON.stringify({ steps: 3 }), path.join("config", "config.json"))
    const info = ConfigParse.schema(CoreConfig.Info, parsed, "config.json")
    expect(info.steps, "the global config file's `steps` key must reach the twin's config").toBe(3)
  })

  it.instance(
    "the app config service exposes the global step limit to the main loop",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig({ steps: 3 })
        const config = yield* Config.Service
        expect((yield* config.get()).steps, "a user set global `steps` must be readable at runtime").toBe(3)
      }),
    20_000,
  )
})
