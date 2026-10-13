import { afterAll, describe, expect, mock } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { CodeSearchTool } from "../../src/tool/codesearch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

// The codesearch tool imports `call` from @opencode-ai/core/tool/mcp-exa and
// reaches the Exa MCP endpoint over the network. Mock the module so the tests
// assert the permission-ask ordering without any real request, mirroring the
// provider-deepinfra mock.module pattern.
const events: Array<"ask" | "exa"> = []
const exaCalls: Array<{ tool: string; value: { query: string; tokensNum: number } }> = []

// Capture both real exports of @opencode-ai/core/tool/mcp-exa BEFORE
// registering the mock so we can restore them via afterAll. Same leak class
// as the other task files; this module exposes a `CodeArgs` schema AND a
// `call` Effect, both of which later sibling tests may rely on for real
// parsing and real Exa network behavior.
const realMcpExa = await import("@opencode-ai/core/tool/mcp-exa")
const realCodeArgs = realMcpExa.CodeArgs
const realCall = realMcpExa.call

void mock.module("@opencode-ai/core/tool/mcp-exa", () => ({
  CodeArgs: {},
  call: (_http: unknown, tool: string, _args: unknown, value: { query: string; tokensNum: number }) => {
    events.push("exa")
    exaCalls.push({ tool, value })
    return Effect.succeed(`code results for ${value.query}`)
  },
}))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const exec = Effect.fn("CodeSearchToolTest.exec")(function* (args: Tool.InferParameters<typeof CodeSearchTool>) {
  const info = yield* CodeSearchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.codesearch", () => {
  it.instance("asks for codesearch permission before the Exa call", () =>
    Effect.gen(function* () {
      events.length = 0
      exaCalls.length = 0
      const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const askingCtx: Tool.Context = {
        ...ctx,
        ask: (input) =>
          Effect.sync(() => {
            events.push("ask")
            asks.push(input)
          }),
      }
      const info = yield* CodeSearchTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "effect http client usage" }, askingCtx)
      expect(result.output).toBe("code results for effect http client usage")
      expect(events).toEqual(["ask", "exa"])
      expect(asks.length).toBe(1)
      expect(asks[0].permission).toBe("codesearch")
      expect(asks[0].patterns).toEqual(["effect http client usage"])
      expect(asks[0].metadata).toEqual({ query: "effect http client usage", tokensNum: 5000 })
      expect(exaCalls.length).toBe(1)
      expect(exaCalls[0].tool).toBe("get_code_context_exa")
      expect(exaCalls[0].value).toEqual({ query: "effect http client usage", tokensNum: 5000 })
    }),
  )

  it.instance("does not call Exa when permission is denied", () =>
    Effect.gen(function* () {
      events.length = 0
      exaCalls.length = 0
      const deniedCtx: Tool.Context = {
        ...ctx,
        ask: () => Effect.die(new Error("permission denied by user")),
      }
      const info = yield* CodeSearchTool
      const tool = yield* info.init()
      const exit = yield* tool.execute({ query: "denied query" }, deniedCtx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(events).toEqual([])
      expect(exaCalls.length).toBe(0)
    }),
  )
})

afterAll(() => {
  mock.module("@opencode-ai/core/tool/mcp-exa", () => ({
    CodeArgs: realCodeArgs,
    call: realCall,
  }))
})
