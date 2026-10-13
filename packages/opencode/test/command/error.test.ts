import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { ConfigCommand } from "../../src/config/command"
import { tmpdir } from "../fixture/fixture"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

describe("ConfigCommand.load error handling", () => {
  test("invalid frontmatter throws", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "commands", "bad.md"),
          `---
description: Bad
subtask: 42
---
Hello`,
        )
      },
    })
    await expect(ConfigCommand.load(tmp.path)).rejects.toThrow(InvalidError)
  })

  test("frontmatter with wrong type for optional string field throws", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "commands", "bad.md"),
          `---
description: My command
agent: true
---
Hello`,
        )
      },
    })
    await expect(ConfigCommand.load(tmp.path)).rejects.toThrow(InvalidError)
  })

  test("empty commands dir returns {}", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "commands"), { recursive: true })
      },
    })
    const result = await ConfigCommand.load(tmp.path)
    expect(result).toEqual({})
  })

  test("nonexistent commands dir returns {}", async () => {
    await using tmp = await tmpdir()
    const result = await ConfigCommand.load(tmp.path)
    expect(result).toEqual({})
  })

  test("deeply nested commands still load", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "commands", "a", "b", "c", "deep.md"),
          `---
description: Deeply nested
---
Deep template`,
        )
      },
    })
    const result = await ConfigCommand.load(tmp.path)
    expect(result["a/b/c/deep"].description).toBe("Deeply nested")
    expect(result["a/b/c/deep"].template).toBe("Deep template")
  })
})
