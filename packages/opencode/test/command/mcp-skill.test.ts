import { describe, expect } from "bun:test"
import { Command } from "@/command"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { makeCommandLayerTest } from "./shared"

const it = makeCommandLayerTest("/tmp/test-mcp-skill", {
  mcp: MCP.Test.withPrompts({
    "my-prompt": { description: "a sample MCP prompt" },
  }),
  skill: Skill.Test.withCommands({
    "my-skill": { description: "a sample skill" },
  }),
})

describe("MCP prompts as commands", () => {
  it.effect("MCP prompt appears in registry with source=mcp", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("my-prompt")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("mcp")
    }),
  )
})

describe("Skill commands", () => {
  it.effect("skill appears in registry with source=skill", () =>
    Effect.gen(function* () {
      const registry = yield* Command.Service
      const cmd = yield* registry.get("my-skill")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("skill")
    }),
  )
})
