// Title generation must never block the run loop and must never fail silently.
// Pinned at source level against the title step in prompt.ts: the call is forked
// into the instance scope (as upstream opencode 1.18.15 prompt.ts:1141-1147 does)
// and any failure is logged as a warning that carries the session id, so the
// retry-while-default logic on the following steps stays observable.
import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"

const PROMPT_INDEX = path.resolve(import.meta.dir, "../../src/session/prompt.ts")

describe("title generation in the run loop", () => {
  test("prompt.ts forks the title call and logs failures with the session id", async () => {
    const source = await fs.readFile(PROMPT_INDEX, "utf-8")

    const idx = source.indexOf("yield* title({")
    expect(idx).toBeGreaterThan(-1)

    // The pipe that follows the title call, up to the closing of the surrounding
    // `if (Session.isDefaultTitle(...))` block.
    const tail = source.slice(idx)
    const end = tail.indexOf("\n            }\n          }")
    expect(end).toBeGreaterThan(-1)
    const block = tail.slice(0, end)

    // Never awaited inline: no timeout cap, forked into the instance scope.
    expect(block).not.toMatch(/Effect\.timeout\(/)
    expect(block).toMatch(/Effect\.forkIn\(scope\)/)

    // Failures are logged, not swallowed silently, and carry the session id.
    expect(block).toMatch(/Effect\.catchCause\(/)
    expect(block).toMatch(/Effect\.logWarning\(/)
    expect(block).toMatch(/"session\.id":\s*sessionID/)
    expect(block).toMatch(/error:\s*Cause\.squash\(cause\)/)
  })
})
