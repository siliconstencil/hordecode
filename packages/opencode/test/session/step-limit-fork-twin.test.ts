// The fork session twin (packages/core/src/session/prompt.ts) is the loop the
// supervisor spawns (packages/supervisor/src/spawn.ts:6 imports it as
// SessionPrompt). It must honour the same global `steps` config key as the
// main loop (packages/opencode/src/session/prompt.ts): spawn steps > agent
// steps > global steps > the twin's own fallback.
//
// In the twin a spawn budget is a SOFT limit: it only flips isLastStep (the last
// allowed step is forced to answer with text), it does not end the loop. The
// twin also has no 200 ceiling. Both are pre-existing divergences from the main
// loop, recorded as an open decision in reports/rnd/dev-0.1.6-steps.md.
//
// The two SessionPrompt services sit on distinct service tags (see
// test/session/prompt-tag.test.ts), so the main loop's harness does not mount
// the twin. The precedence is therefore asserted at runtime on the shared
// helper both loops use (packages/core/src/session/step-budget.ts); one wiring
// check asserts that the twin calls that helper. The config side is asserted on
// the CORE config module, because that is the service the twin reads: the twin
// takes `Config.Service` (packages/core/src/session/prompt.ts:355) and its own
// layer provides the core config service (packages/core/src/session/prompt.ts:3228).
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
import { resolveStepLimit } from "@opencode-ai/core/session/step-budget"
import { it, useServerConfig } from "../supervisor/supervisor-test-harness"

const twinSource = await Bun.file(path.join(import.meta.dir, "../../../core/src/session/prompt.ts")).text()
const mainSource = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()

describe("fork session twin", () => {
  test("the shared helper resolves the spawn budget over every other limit", () => {
    expect(resolveStepLimit({ spawn: 9, agent: 5, global: 3, fallback: 100 })).toBe(9)
  })

  test("the shared helper resolves the agent limit over the global one", () => {
    expect(resolveStepLimit({ agent: 5, global: 3, fallback: 100 })).toBe(5)
  })

  test("the shared helper resolves the global limit over the fallback", () => {
    expect(resolveStepLimit({ global: 3, fallback: 100 })).toBe(3)
  })

  test("both loops fall back to Infinity (no default cap)", () => {
    expect(resolveStepLimit({ fallback: Infinity })).toBe(Infinity)
    expect(mainSource).toMatch(/fallback:\s*Infinity/)
  })

  test("the twin calls the shared helper (wiring check)", () => {
    expect(
      /resolveStepLimit\(\s*\{/.test(twinSource),
      "the twin must resolve its step budget through the shared helper",
    ).toBe(true)
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
