import { describe, expect, test } from "bun:test"
import { Cause, Effect, Schema } from "effect"
import { shellWrapSettle, shellInputSchema } from "../../src/tool/shell-wrap"

function makeSettle(text: string, metadata: Record<string, unknown> = {}) {
  return () => Effect.succeed({ content: [{ type: "text" as const, text }], structured: {}, metadata } as any)
}

function makeRecordingSettle(record: { calls: Record<string, unknown>[] }, failOp?: string) {
  return (call: { input: unknown }) => {
    const input = call.input as Record<string, unknown>
    record.calls.push(input)
    if (failOp && (input as { operation?: string }).operation === failOp) return Effect.fail(new Error(`tool boom on ${input.value}`)) as any
    const op = (input as { operation?: string }).operation ?? "?"
    return Effect.succeed({ content: [{ type: "text" as const, text: `ran ${op}${(input as { value?: string }).value ? " " + (input as { value?: string }).value : ""}` }], structured: {}, metadata: { operation: op } } as any)
  }
}

describe("shell-wrap", () => {
  test("schema accepts script", async () => {
    const d = await Effect.runPromise(Schema.decodeUnknownEffect(shellInputSchema)({ script: "read file.txt" }))
    expect(d.script).toBe("read file.txt")
  })

  test("single command wraps output and metadata", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (s: string) =>
        Effect.succeed(
          s
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((line) => {
              const tokens = line.trim().split(/\s+/)
              return { operation: tokens[1], value: tokens[2] } as Record<string, unknown>
            }),
        ),
    }
    const wrapped = shellWrapSettle("synthetic", shell, makeRecordingSettle(record) as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "synthetic create" } } as any, { sessionID: "s" } as any))
    expect(record.calls).toEqual([{ operation: "create", value: undefined }])
    const text = (r.content[0] as any).text as string
    expect(text).toContain('<command index="1" operation="create">')
    expect(text).toContain("ran create")
    expect(text).toContain("</command>")
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(1)
    expect(meta.success).toBe(1)
  })

  test("two commands run in order, both succeed, metadata reflects counts", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (s: string) =>
        Effect.succeed(
          s
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((line) => {
              const t = line.trim().split(/\s+/)
              return { operation: t[1], value: t[2] } as Record<string, unknown>
            }),
        ),
    }
    const wrapped = shellWrapSettle("synthetic", shell, makeRecordingSettle(record) as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "synthetic create A\nsynthetic update B" } } as any, { sessionID: "s" } as any))
    expect(record.calls).toEqual([
      { operation: "create", value: "A" },
      { operation: "update", value: "B" },
    ])
    const text = (r.content[0] as any).text as string
    expect((text.match(/<command/g) ?? []).length).toBe(2)
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(2)
    expect(meta.success).toBe(2)
  })

  test("failure on cmd #2 stops; cmd #3 marked not-executed", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (s: string) =>
        Effect.succeed(
          s
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((line) => {
              const t = line.trim().split(/\s+/)
              return { operation: t[1], value: t[2] } as Record<string, unknown>
            }),
        ),
    }
    const wrapped = shellWrapSettle("synthetic", shell, makeRecordingSettle(record, "boom") as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "synthetic create A\nsynthetic boom B\nsynthetic create C" } } as any, { sessionID: "s" } as any))
    expect(record.calls.map((c) => (c as { operation: string }).operation)).toEqual(["create", "boom"])
    const text = (r.content[0] as any).text as string
    expect(text).toContain('<command index="2" operation=')
    expect(text).toContain('failed="true"')
    expect(text).toContain("tool boom on B")
    expect(text).toContain("<not-executed>commands #3..#3</not-executed>")
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(3)
    expect(meta.success).toBe(1)
  })

  test("parse error teaching", async () => {
    const shell = { description: "test", parse: (_: string) => Effect.fail({ kind: "unsupported-operator", line: 2, detail: "unsupported shell operator: |" }) }
    const wrapped = shellWrapSettle("synthetic", shell, makeSettle("x") as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "bad" } } as any, { sessionID: "s" } as any))
    const text = (r.content[0] as any).text as string
    expect(text).toContain('<command failed="true">')
    expect(text).not.toContain("operation=")
    expect(text).toContain("parse error at line 2")
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(0)
    expect(meta.success).toBe(0)
  })

  test("whitespace-only script returns error envelope with 0,0", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (s: string) => Effect.succeed([{ operation: s } as Record<string, unknown>]),
    }
    const wrapped = shellWrapSettle("synthetic", shell, makeRecordingSettle(record) as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "   \n  " } } as any, { sessionID: "s" } as any))
    expect(record.calls).toEqual([])
    const text = (r.content[0] as any).text as string
    expect(text).toContain('<command failed="true">')
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(0)
    expect(meta.success).toBe(0)
  })

  test("formatFailedCommand escapes operation attribute", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (_: string) => Effect.succeed([{ operation: 'a"b&<c>' } as Record<string, unknown>]),
    }
    const wrapped = shellWrapSettle("synthetic", shell, (_call) => Effect.fail(new Error("boom")) as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "x" } } as any, { sessionID: "s" } as any))
    const text = (r.content[0] as any).text as string
    expect(text).toContain('operation="a&quot;b&amp;&lt;c&gt;"')
  })

  test("recover path", async () => {
    const shell = {
      description: "test",
      parse: (s: string) => Effect.succeed([{ operation: "test" }]),
      recover: (args: unknown) => {
        const o = args as Record<string, unknown>
        if (o && "operation" in o) return o as Record<string, unknown>
        return undefined
      },
    }
    const wrapped = shellWrapSettle("test", shell, makeSettle("ok") as any)
    const r = await Effect.runPromise(wrapped({ name: "test", id: "1", input: { operation: "test" } } as any, { sessionID: "s" } as any))
    expect((r.content[0] as any).text).toContain("ok")
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(1)
    expect(meta.success).toBe(1)
  })

  test("JSON double-escape rescue adds notice", async () => {
    const record = { calls: [] as Record<string, unknown>[] }
    const shell = {
      description: "test",
      parse: (script: string) => {
        if (/\\n/.test(script)) return Effect.fail({ kind: "unsupported-operator", line: 1, detail: "literal backslash-n" })
        return Effect.succeed(
          script
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((line) => {
              const t = line.trim().split(/\s+/)
              return { operation: t[1], value: t[2] } as Record<string, unknown>
            }),
        )
      },
    }
    const wrapped = shellWrapSettle("synthetic", shell, makeRecordingSettle(record) as any)
    const r = await Effect.runPromise(wrapped({ name: "synthetic", id: "1", input: { script: "synthetic create A\\nsynthetic update B" } } as any, { sessionID: "s" } as any))
    expect(record.calls).toEqual([
      { operation: "create", value: "A" },
      { operation: "update", value: "B" },
    ])
    const text = (r.content[0] as any).text as string
    expect(text).toContain("<notice>")
    expect((r as unknown as { metadata: Record<string, unknown> }).metadata.success).toBe(2)
  })
})
