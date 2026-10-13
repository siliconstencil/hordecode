import { describe, expect } from "bun:test"
import { Command } from "@/command"
import { Effect } from "effect"
import { makeCommandLayerTest } from "./shared"

const it = makeCommandLayerTest("/tmp/test-smoke")

describe("command registry", () => {
  it.effect("lists built-in commands", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const commands = yield* registry.list()
      const names = commands.map((c) => c.name)
      expect(names).toContain("init")
      expect(names).toContain("review")
      expect(names).toContain("dream")
      expect(names).toContain("distill")
      expect(names).toContain("goal")
      expect(names).toContain("deep-research")
      expect(names).toContain("loops")
    }),
  )

  it.effect("built-in commands have descriptions", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const commands = yield* registry.list()
      // MCP/skill-sourced commands may legitimately lack a description until
      // their provider supplies one; only built-in commands must always have
      // one. (A larger product-level filter belongs post-0.3.0.)
      const builtIn = commands.filter((c) => c.source === "command")
      expect(builtIn.length).toBeGreaterThan(0)
      for (const cmd of builtIn) {
        expect(cmd.description).toBeTruthy()
      }
    }),
  )

  it.effect("get returns undefined for unknown", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const result = yield* registry.get("nonexistent-command-smoke-test")
      expect(result).toBeUndefined()
    }),
  )
})
