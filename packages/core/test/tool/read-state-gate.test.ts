import { describe, expect, test } from "bun:test"
import { assertFileRead } from "../../src/tool/read-state"
import { isRecoverableError } from "../../src/tool/recoverable"

function ctxWithReads(filePaths: string[], sessionID = "test-session" as any): any {
  return {
    sessionID,
    messages: filePaths.length
      ? [
          {
            parts: filePaths.map((fp) => ({
              type: "tool" as const,
              tool: "read",
              state: { status: "completed" as const, input: { file_path: fp } },
            })),
          },
        ]
      : [],
  }
}

describe("assertFileRead edit-gate", () => {
  test("throws RecoverableError when file has not been read", () => {
    const ctx = ctxWithReads([])
    let caught: unknown
    try {
      assertFileRead(ctx, "/tmp/foo.txt", "edit")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(isRecoverableError(caught)).toBe(true)
    expect((caught as Error).message).toContain("has not been read in this conversation")
    expect((caught as Error).message).toContain("Call the read tool")
  })

  test("throws with toolId prefix in message", () => {
    const ctx = ctxWithReads([])
    try {
      assertFileRead(ctx, "/tmp/bar.py", "notebook_edit")
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as Error).message).toContain("notebook_edit: /tmp/bar.py has not been read")
    }
  })

  test("does not throw when file was previously read", () => {
    const ctx = ctxWithReads(["/tmp/foo.txt"])
    expect(() => assertFileRead(ctx, "/tmp/foo.txt", "edit")).not.toThrow()
  })

  test("matches path canonically (relative vs absolute via SessionCwd)", () => {
    // Using absolute paths only for deterministic test without SessionCwd setup
    const ctx = ctxWithReads(["/tmp/a/b.txt"])
    expect(() => assertFileRead(ctx, "/tmp/a/b.txt", "edit")).not.toThrow()
  })

  test("ignores non-completed or non-read tool parts", () => {
    const ctx: any = {
      sessionID: "test-session",
      messages: [
        {
          parts: [
            { type: "tool", tool: "read", state: { status: "pending", input: { file_path: "/tmp/foo.txt" } } },
            { type: "tool", tool: "write", state: { status: "completed", input: { file_path: "/tmp/foo.txt" } } },
          ],
        },
      ],
    }
    expect(() => assertFileRead(ctx, "/tmp/foo.txt", "edit")).toThrow()
  })

  test("returns early when ctx.messages is undefined (optional guard)", () => {
    const ctx: any = { sessionID: "test-session" }
    expect(() => assertFileRead(ctx, "/tmp/anything.txt", "edit")).not.toThrow()
  })

  // The gate was ported from MiMo Code (read input key `file_path`); the
  // opencode read tool emits `filePath` and the core read tool `path`. In the
  // In an end-to-end test every edit failed because only `file_path` matched.
  test("matches the opencode read tool key `filePath`", () => {
    const ctx: any = {
      sessionID: "test-session",
      messages: [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/tmp/a.txt" } } }] }],
    }
    expect(() => assertFileRead(ctx, "/tmp/a.txt", "edit")).not.toThrow()
  })

  test("matches the core read tool key `path`", () => {
    const ctx: any = {
      sessionID: "test-session",
      messages: [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { path: "/tmp/b.txt" } } }] }],
    }
    expect(() => assertFileRead(ctx, "/tmp/b.txt", "edit")).not.toThrow()
  })

  test("uses the caller cwd to anchor a relative read path", () => {
    const ctx: any = {
      sessionID: "test-session",
      messages: [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/c.txt" } } }] }],
    }
    expect(() => assertFileRead(ctx, "/work/src/c.txt", "edit", "/work")).not.toThrow()
  })

  test("a relative read path without cwd or Instance context is a recoverable miss, not a crash", () => {
    const ctx: any = {
      sessionID: "test-session",
      messages: [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/d.txt" } } }] }],
    }
    try {
      assertFileRead(ctx, "/work/src/d.txt", "edit")
      throw new Error("expected throw")
    } catch (e) {
      expect(isRecoverableError(e)).toBe(true)
    }
  })
})
