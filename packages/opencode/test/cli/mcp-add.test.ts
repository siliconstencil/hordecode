import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "hordecode", "hordecode.json")).json(),
        )
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "hordecode", "hordecode.json")).json(),
        )
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  //  when invoked with no --name and no other flags in a non-TTY
  // environment, the command previously fell into the @clack/prompts flow and
  // silently blocked reading STDIN. The fix surfaces a clear TTY-required
  // error pointing the caller to the non-interactive flag set. The CLI
  // subprocess harness here already spawns with `stdin: "ignore"`, which is
  // exactly the non-TTY shape this gate protects against.
  cliIt.concurrent(
    "rejects a no-flag invocation in a non-TTY environment with a TTY-required error",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "add"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("requires a TTY")
        expect(result.stderr).toContain("hordecode mcp add <name> --url <url>")
      }),
    60_000,
  )
})
