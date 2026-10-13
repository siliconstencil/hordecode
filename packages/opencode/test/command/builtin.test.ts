import { describe, expect } from "bun:test"
import { Command } from "@/command"
import { Effect } from "effect"
import { makeCommandLayerTest } from "./shared"

const it = makeCommandLayerTest("/tmp/test-builtin")

describe("builtin commands", () => {
  it.effect("init command template references AGENTS.md", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("init")
      expect(cmd).toBeDefined()
      expect(cmd!.template).toContain("AGENTS.md")
    }),
  )

  it.effect("init command has hints", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("init")
      expect(cmd).toBeDefined()
      expect(cmd!.hints.length).toBeGreaterThan(0)
    }),
  )

  it.effect("review command template is non-empty", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("review")
      expect(cmd).toBeDefined()
      expect(typeof cmd!.template).toBe("string")
      expect((cmd!.template as string).length).toBeGreaterThan(0)
    }),
  )

  it.effect("review command has subtask=true", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("review")
      expect(cmd).toBeDefined()
      expect(cmd!.subtask).toBe(true)
    }),
  )

  it.effect("dream command has agent=\"dream\"", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("dream")
      expect(cmd).toBeDefined()
      expect(cmd!.agent).toBe("dream")
    }),
  )

  it.effect("distill command has agent=\"distill\"", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("distill")
      expect(cmd).toBeDefined()
      expect(cmd!.agent).toBe("distill")
    }),
  )

  it.effect("goal command template equals \"$ARGUMENTS\"", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("goal")
      expect(cmd).toBeDefined()
      expect(cmd!.template).toBe("$ARGUMENTS")
    }),
  )

  it.effect("goal command has \"$ARGUMENTS\" hint", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("goal")
      expect(cmd).toBeDefined()
      expect(cmd!.hints).toContain("$ARGUMENTS")
    }),
  )
})
