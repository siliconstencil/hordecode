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
  const savedCron = Flag.HORDECODE_EXPERIMENTAL_CRON
  const savedWorkflow = Flag.HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL

  beforeAll(() => {
    Flag.HORDECODE_EXPERIMENTAL_CRON = false
    Flag.HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL = false
  })

  afterAll(() => {
    Flag.HORDECODE_EXPERIMENTAL_CRON = savedCron
    Flag.HORDECODE_EXPERIMENTAL_WORKFLOW_TOOL = savedWorkflow
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
