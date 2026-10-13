// Per-supervisor tool allowlist. A supervisor row with a tools array may only
// execute the tools on it. Enforcement happens at execute time, the same way MiMo does it
// (mimocode-v0.1.11/packages/opencode/src/session/prompt.ts:1234-1281 whitelist, :1354 and :1493
// rejection). The tool stays in the map so the schema list is unchanged (spawn.ts:74-83).
// Unit-level: drives SessionTools.resolve with a fake registry; it does not run a full turn.
delete process.env["OPENCODE_DB"]

import { describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"

const { MCP } = await import("@/mcp")
const { Permission } = await import("@/permission")
const { Plugin } = await import("@/plugin")
const { Truncate } = await import("@/tool/truncate")
const { ToolRegistry } = await import("@/tool/registry")
const { SessionTools } = await import("@/session/tools")
const { SessionID, MessageID } = await import("@/session/schema")
const { RuntimeFlags } = await import("@/effect/runtime-flags")
const { ProviderV2 } = await import("@opencode-ai/core/provider")
const { ModelV2 } = await import("@opencode-ai/core/model")

function spyTool(id: string, calls: string[]) {
  return {
    id,
    description: id,
    parameters: Schema.Struct({}),
    jsonSchema: { type: "object", properties: {} },
    execute: () =>
      Effect.sync(() => {
        calls.push(id)
        return { title: id, metadata: {}, output: `${id} ran` }
      }),
  }
}

function layerWith(tools: Array<ReturnType<typeof spyTool>>) {
  return Layer.mergeAll(
    Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
        reloadFileHooks: () => Effect.void,
      } as never),
    ),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({ ask: () => Effect.void, reply: () => Effect.void, list: () => Effect.succeed([]) } as never),
    ),
    Layer.succeed(MCP.Service, MCP.Service.of({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) } as never)),
    Layer.succeed(
      Truncate.Service,
      Truncate.Service.of({ output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as never),
    ),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(tools.map((t) => t.id)),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        reload: () => Effect.void,
        tools: () => Effect.succeed(tools),
      } as never),
    ),
  )
}

async function resolveWith(toolWhitelist: readonly string[] | undefined, calls: string[]) {
  const sessionID = SessionID.descending()
  const processor = {
    message: { id: MessageID.ascending(), sessionID, role: "assistant" },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
  }
  const tools = await Effect.runPromise(
    SessionTools.resolve({
      agent: { name: "general", mode: "subagent", options: {}, permission: [] } as never,
      model: { providerID: ProviderV2.ID.make("test"), api: { id: ModelV2.ID.make("test-model") } } as never,
      session: { id: sessionID, permission: [] } as never,
      processor: processor as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      toolWhitelist,
    } as never).pipe(Effect.provide(layerWith([spyTool("read", calls), spyTool("write", calls)]))),
  )
  const opts = { toolCallId: "call", abortSignal: new AbortController().signal, messages: [] }
  return {
    tools,
    read: await (tools.read as any).execute({}, opts),
    write: await (tools.write as any).execute({}, opts),
  }
}

describe("per-supervisor tool allowlist", () => {
  it("a tool outside the supervisor allowlist is rejected and its execute never runs", async () => {
    const calls: string[] = []
    const { write } = await resolveWith(["read"], calls)
    expect(write.metadata).toEqual({ rejected: true, reason: "tool-whitelist" })
    expect(write.output).toContain("not in this supervisor's whitelist")
    expect(calls).not.toContain("write")
  })

  it("a tool on the allowlist still runs", async () => {
    const calls: string[] = []
    const { read } = await resolveWith(["read"], calls)
    expect(read.output).toBe("read ran")
    expect(calls).toEqual(["read"])
  })

  it("no allowlist (INHERIT or missing row) keeps full access", async () => {
    const calls: string[] = []
    const { write } = await resolveWith(undefined, calls)
    expect(write.output).toBe("write ran")
    expect(calls).toEqual(["read", "write"])
  })
})
