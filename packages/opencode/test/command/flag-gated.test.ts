import { describe, expect, beforeAll, afterAll } from "bun:test"
import { Command } from "@/command"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { makeCommandLayerTest } from "./shared"

const it = makeCommandLayerTest("/tmp/test-flag-gated")

describe("flag-gated commands (default enabled)", () => {
  it.effect("deep-research has source=command when HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("deep-research")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("command")
    }),
  )

  it.effect("loops has source=command when HORDECODE_EXPERIMENTAL_CRON is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("loops")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("command")
    }),
  )
})

describe("flag-gated commands disabled", () => {
  // The flags are getters over the env (core/src/flag/flag.ts), so the test sets the env names.
  const savedCron = process.env.HORDECODE_EXPERIMENTAL_CRON
  const savedWorkflow = process.env.HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  beforeAll(() => {
    process.env.HORDECODE_EXPERIMENTAL_CRON = "false"
    process.env.HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL = "false"
    expect(Flag.HORDECODE_EXPERIMENTAL_CRON).toBe(false)
  })

  afterAll(() => {
    restore("HORDECODE_EXPERIMENTAL_CRON", savedCron)
    restore("HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL", savedWorkflow)
  })

  it.effect("deep-research has source=skill when HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("deep-research")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("skill")
    }),
  )

  it.effect("loops absent when HORDECODE_EXPERIMENTAL_CRON is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("loops")
      expect(cmd).toBeUndefined()
    }),
  )
})
