import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { shellWrapSettle } from "../../src/tool/shell-wrap"

describe("shell-wrap-missing-script", () => {
  test("missing script without recover returns 0,0 teaching", async () => {
    const shell = { description: "t", parse: (s: string) => Effect.succeed([{ operation: s }]) }
    const w = shellWrapSettle("t", shell, (() => Effect.succeed({ content: [{ type: "text", text: "x" }], structured: {} } as any)) as any)
    const r: any = await Effect.runPromise(w({ name: "t", id: "1", input: {} } as any, { sessionID: "s" } as any) as any)
    const txt = (r.content[0] as any).text as string
    expect(txt.includes("script") || txt.includes("could not run")).toBe(true)
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(0)
    expect(meta.success).toBe(0)
  })
  test("empty script returns 0,0", async () => {
    const shell = { description: "t", parse: (s: string) => Effect.succeed([{ operation: s }]) }
    const w = shellWrapSettle("t", shell, (() => Effect.succeed({ content: [{ type: "text", text: "x" }], structured: {} } as any)) as any)
    const r: any = await Effect.runPromise(w({ name: "t", id: "1", input: { script: "   " } } as any, { sessionID: "s" } as any) as any)
    expect((r.content[0] as any).text).toContain("script")
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(0)
    expect(meta.success).toBe(0)
  })
  test("recover returns op routed to execute with 1,1 and no teaching", async () => {
    const received: unknown[] = []
    const recovered = { operation: "test", value: "v" }
    const shell = {
      description: "t",
      parse: (s: string) => Effect.succeed([{ operation: s }] as any),
      recover: () => recovered,
    }
    const settle = (call: any) => { received.push(call.input); return Effect.succeed({ content: [{ type: "text", text: "ok executed" }], structured: {}, metadata: { operation: "test" } } as any) }
    const w = shellWrapSettle("t", shell, settle as any)
    const r: any = await Effect.runPromise(w({ name: "t", id: "1", input: { operation: "test" } } as any, { sessionID: "s" } as any) as any)
    expect(received).toEqual([recovered])
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(1)
    expect(meta.success).toBe(1)
    const txt = (r.content[0] as any).text as string
    expect(txt).toContain("ok executed")
    expect(txt.toLowerCase()).not.toContain("takes a single")
  })
  test("recover failure returns 0,0 json teaching", async () => {
    const recovered = { operation: "test" }
    const shell = { description: "t", parse: (s: string) => Effect.succeed([] as any), recover: () => recovered }
    const settle = () => Effect.fail(new Error("validation: missing prompt")) as any
    const w = shellWrapSettle("t", shell, settle as any)
    const r: any = await Effect.runPromise(w({ name: "t", id: "1", input: { operation: "test" } } as any, { sessionID: "s" } as any) as any)
    const meta = (r as unknown as { metadata: Record<string, unknown> }).metadata
    expect(meta.commands).toBe(0)
    expect(meta.success).toBe(0)
    expect((r.content[0] as any).text.toLowerCase()).toContain("operation")
  })
})
