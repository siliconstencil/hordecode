import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigCommand } from "../../src/config/command"
import { tmpdir } from "../fixture/fixture"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

describe("ConfigCommand.load", () => {
  test("returns empty object when no command files exist", async () => {
    await using tmp = await tmpdir()
    const result = await ConfigCommand.load(tmp.path)
    expect(result).toEqual({})
  })

  test("loads a single command from command/ directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "command", "hello.md"),
          `---
description: Say hello
---
Hello, world!`,
        )
      },
    })
    const result = await ConfigCommand.load(tmp.path)
    expect(result.hello.description).toBe("Say hello")
    expect(result.hello.template).toBe("Hello, world!")
  })

  test("loads a single command from commands/ directory (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "commands", "greet.md"),
          `---
description: Greet the user
---
Greetings!`,
        )
      },
    })
    const result = await ConfigCommand.load(tmp.path)
    expect(result.greet.description).toBe("Greet the user")
    expect(result.greet.template).toBe("Greetings!")
  })

  test("loads nested commands preserving relative path segments", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "commands", "nested", "child.md"),
          `---
description: Nested command
agent: helper
---
Nested template`,
        )
      },
    })
    const result = await ConfigCommand.load(tmp.path)
    expect(result["nested/child"].description).toBe("Nested command")
    expect(result["nested/child"].agent).toBe("helper")
    expect(result["nested/child"].template).toBe("Nested template")
  })

  test("throws InvalidError when a command file has invalid frontmatter types", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "command", "bad.md"),
          `---
description: Bad command
subtask: notabool
---
Some template`,
        )
      },
    })
    await expect(ConfigCommand.load(tmp.path)).rejects.toThrow(InvalidError)
  })
})
