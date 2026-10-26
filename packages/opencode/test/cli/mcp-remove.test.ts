import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

const configText = `{
  // keep this comment
  "model": "openai/gpt-5",
  "mcp": {
    "keep": {
      "type": "remote",
      "url": "https://keep.example.com/mcp"
    },
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }
}
`

describe("opencode mcp remove (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "removes one server and keeps comments and other entries",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, ".config", "hordecode", "hordecode.json")
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(configPath), { recursive: true })
          await Bun.write(configPath, configText)
        })

        const result = yield* opencode.spawn(["mcp", "remove", "github"])
        opencode.expectExit(result, 0)
        expect(result.stdout + result.stderr).toContain(`Removed MCP server "github" from ${configPath}`)

        const text = yield* Effect.promise(() => Bun.file(configPath).text())
        expect(text).toContain("// keep this comment")
        expect(text).toContain('"model": "openai/gpt-5"')
        expect(text).toContain('"keep"')
        expect(text).not.toContain('"github"')
        expect(text).not.toContain('"https://example.com/mcp"')
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails with the checked paths when the server is not configured",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, ".config", "hordecode", "hordecode.json")
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(configPath), { recursive: true })
          await Bun.write(configPath, configText)
        })

        const result = yield* opencode.spawn(["mcp", "rm", "missing"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain('MCP server "missing" not found')
        expect(result.stderr).toContain(configPath)

        const text = yield* Effect.promise(() => Bun.file(configPath).text())
        expect(text).toContain("// keep this comment")
        expect(text).toContain('"github"')
        expect(text).toContain('"keep"')
      }),
    60_000,
  )
})
