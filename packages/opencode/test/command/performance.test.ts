import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigCommand } from "../../src/config/command"
import { tmpdir } from "../fixture/fixture"

describe("ConfigCommand.load performance", () => {
  test("loads 100 command files in under 2000ms", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const commandsDir = path.join(dir, "commands")
        for (let i = 0; i < 100; i++) {
          await Bun.write(
            path.join(commandsDir, `cmd-${i}.md`),
            `---
description: Command number ${i}
---
Template content for command ${i}`,
          )
        }
      },
    })
    const start = performance.now()
    const result = await ConfigCommand.load(tmp.path)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(2000)
    expect(Object.keys(result)).toHaveLength(100)
  })
})
