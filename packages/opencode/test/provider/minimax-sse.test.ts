import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applyMinimaxSSE, createMinimaxRewriter, isMinimaxAnthropicURL, refloatMinimaxSSE } from "../../src/provider/minimax-sse"
import { timeoutFetch } from "../../src/provider/provider"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/minimax", name), "utf8")

type Event = Record<string, any>

const events = (sse: string): Event[] =>
  sse
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event)

const tools = (sse: string) => {
  const byIndex = new Map<number, { name: string; json: string; stoppedAfterLast: boolean; closed: boolean }>()
  let last: number | undefined
  for (const event of events(sse)) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      byIndex.set(event.index, { name: event.content_block.name, json: "", stoppedAfterLast: false, closed: false })
      last = event.index
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && event.index === last) {
      byIndex.get(event.index)!.json += event.delta.partial_json
      byIndex.get(event.index)!.stoppedAfterLast = false
    }
    if (event.type === "content_block_stop" && event.index === last && byIndex.has(event.index))
      byIndex.get(event.index)!.closed = true
  }
  return [...byIndex.entries()].map(([index, block]) => ({
    index,
    name: block.name,
    json: block.json,
    input: JSON.parse(block.json || "{}") as Record<string, unknown>,
  }))
}

describe("isMinimaxAnthropicURL", () => {
  test("minimax hosts on the anthropic path", () => {
    expect(isMinimaxAnthropicURL("https://api.minimax.io/anthropic/v1/messages")).toBe(true)
    expect(isMinimaxAnthropicURL("https://api.minimaxi.com/anthropic/v1/messages")).toBe(true)
  })
  test("other providers and non-anthropic paths", () => {
    expect(isMinimaxAnthropicURL("https://api.anthropic.com/v1/messages")).toBe(false)
    expect(isMinimaxAnthropicURL("https://api.minimax.io/v1/chat/completions")).toBe(false)
    expect(isMinimaxAnthropicURL("https://example.com/anthropic/v1/messages")).toBe(false)
  })
})

describe("rewriter", () => {
  test("a closing brace tagged with the thinking block's index lands on the tool block", () => {
    const rw = createMinimaxRewriter()
    const parsed = tools(rw.push(fixture("broken-brace.sse")) + rw.flush())
    expect(parsed).toHaveLength(2)
    // The orphan `}` belongs to the second glob, the last tool block of the message.
    expect(parsed[1].input).toEqual({ pattern: "packages/core/src/**/session*.ts" })
  })

  test("a mid-string tail completes the file path", () => {
    const rw = createMinimaxRewriter()
    const out = rw.push(fixture("broken-midstring.sse")) + rw.flush()
    const parsed = tools(out)
    const hit = parsed.find((block) => (block.input as { filePath?: string }).filePath?.endsWith("step-budget.ts"))
    expect(hit).toBeDefined()
    expect((hit!.input as { filePath: string }).filePath).toContain("mmx-repro")
  })

  test("a bash command split across the wrong index parses", () => {
    const rw = createMinimaxRewriter()
    const parsed = tools(rw.push(fixture("broken-bash.sse")) + rw.flush())
    const hit = parsed.find((block) => typeof (block.input as { command?: unknown }).command === "string")
    expect(hit).toBeDefined()
  })

  test("a tail split across several orphan chunks is fully repaired", () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "glob", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":"x' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: " too." } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]
    const sse = events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("")
    const rw = createMinimaxRewriter()
    expect(tools(rw.push(sse) + rw.flush())[0].input).toEqual({ pattern: "x" })
  })

  test("the stray thinking text stays in its own block", () => {
    const rw = createMinimaxRewriter()
    const out = rw.push(fixture("broken-brace.sse")) + rw.flush()
    const thinking = events(out).filter((e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta")
    expect(thinking.some((e) => e.index === 3 && e.delta.thinking === " too.")).toBe(true)
  })

  test("a comment between the stop and the tail does not release the stop", () => {
    const sse =
      "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c", name: "glob", input: {} } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":"x' } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n" +
      ": keepalive\n\n" +
      "data: " + JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"}' } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "message_stop" }) + "\n\n"
    const rw = createMinimaxRewriter()
    expect(tools(rw.push(sse) + rw.flush())[0].input).toEqual({ pattern: "x" })
  })

  test("a clean MiniMax stream is unchanged", () => {
    const source = fixture("clean.sse")
    const rw = createMinimaxRewriter()
    expect(rw.push(source) + rw.flush()).toBe(source)
  })

  test("a non-MiniMax Anthropic stream is unchanged", () => {
    const source = fixture("other-anthropic.sse")
    const rw = createMinimaxRewriter()
    expect(rw.push(source) + rw.flush()).toBe(source)
  })

  test("chunk boundaries do not change the output", () => {
    const source = fixture("broken-brace.sse")
    const whole = createMinimaxRewriter()
    const expected = whole.push(source) + whole.flush()
    const rw = createMinimaxRewriter()
    let out = ""
    for (const ch of source) out += rw.push(ch)
    out += rw.flush()
    expect(out).toBe(expected)
  })

  test("no bytes are invented: the moved chunk is the server's bytes", () => {
    const out = createMinimaxRewriter()
    const rewritten = out.push(fixture("broken-brace.sse")) + out.flush()
    const deltas = events(rewritten)
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json as string)
    const original = events(fixture("broken-brace.sse"))
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json as string)
    expect(deltas.sort()).toEqual(original.sort())
  })
})

describe("applyMinimaxSSE", () => {
  const broken = fixture("broken-brace.sse")
  const response = () =>
    new Response(broken, { status: 200, headers: { "content-type": "text/event-stream" } })

  test("rewrites a MiniMax Anthropic SSE response", async () => {
    const res = applyMinimaxSSE("https://api.minimax.io/anthropic/v1/messages", response())
    expect(tools(await res.text())[0].input).toEqual({ pattern: "packages/core/src/session/**" })
  })

  test("leaves another provider's response untouched", async () => {
    const input = "https://api.anthropic.com/v1/messages"
    const res = applyMinimaxSSE(input, response())
    expect(await res.text()).toBe(broken)
  })

  test("leaves a non-SSE response untouched", async () => {
    const input = "https://api.minimax.io/anthropic/v1/messages"
    const original = new Response("{}", { headers: { "content-type": "application/json" } })
    const res = applyMinimaxSSE(input, original)
    expect(await res.text()).toBe("{}")
  })

  test("byte-sized network chunks do not stall the stream", async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of broken) c.enqueue(enc.encode(ch))
        c.close()
      },
    })
    const res = refloatMinimaxSSE(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    const out = await Promise.race([res.text(), Bun.sleep(3000).then(() => "STALL")])
    expect(tools(out)[0].input).toEqual({ pattern: "packages/core/src/session/**" })
  })

  test("refloatMinimaxSSE keeps status and content-type", async () => {
    const res = refloatMinimaxSSE(response())
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
  })
})

describe("timeoutFetch wiring", () => {
  const options = (body: string) => ({
    fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
  })

  test("a MiniMax Anthropic response is repaired on the fetch path", async () => {
    const res = await timeoutFetch(options(fixture("broken-brace.sse")))("https://api.minimax.io/anthropic/v1/messages", {})
    expect(tools(await res.text())[1].input).toEqual({ pattern: "packages/core/src/**/session*.ts" })
  })

  test("another provider's response passes through the fetch path unchanged", async () => {
    const broken = fixture("broken-brace.sse")
    const res = await timeoutFetch(options(broken))("https://api.anthropic.com/v1/messages", {})
    expect(await res.text()).toBe(broken)
  })
})

describe("through @ai-sdk/anthropic", () => {
  const serve = (body: string) =>
    (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch

  const run = async (body: string) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic")
    const { streamText, jsonSchema } = await import("ai")
    const provider = createAnthropic({
      apiKey: "test",
      baseURL: "https://api.minimax.io/anthropic/v1",
      fetch: serve(body),
    })
    const result = streamText({
      model: provider("MiniMax-M3.1-Flash"),
      prompt: "hello",
      tools: { glob: { inputSchema: jsonSchema({ type: "object" }) } },
      maxRetries: 0,
    })
    try {
      await result.consumeStream()
      return { calls: await result.toolCalls, error: undefined as string | undefined }
    } catch (error) {
      return { calls: [] as Array<{ input: unknown }>, error: String((error as Error)?.message ?? error) }
    }
  }

  test("the raw broken stream does not yield the complete tool input", async () => {
    const out = await run(fixture("broken-brace.sse"))
    const second = out.calls[1]?.input as { pattern?: string } | undefined
    // Either the SDK rejects the truncated JSON (error) or the input is incomplete;
    // both are the pre-fix behavior this test pins.
    expect(out.error !== undefined || second?.pattern !== "packages/core/src/**/session*.ts").toBe(true)
  })

  test("the repaired stream yields the complete tool input", async () => {
    const rw = createMinimaxRewriter()
    const out = await run(rw.push(fixture("broken-brace.sse")) + rw.flush())
    expect(out.error).toBeUndefined()
    expect(out.calls).toHaveLength(2)
    expect(out.calls[1].input).toEqual({ pattern: "packages/core/src/**/session*.ts" })
  })
})
