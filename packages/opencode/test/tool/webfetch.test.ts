import { describe, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("rejects an SSRF address before any permission ask or HTTP request", () =>
    Effect.gen(function* () {
      const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const askingCtx: Tool.Context = {
        ...ctx,
        ask: (input) =>
          Effect.sync(() => {
            asks.push(input)
          }),
      }
      const info = yield* WebFetchTool
      const tool = yield* info.init()
      const exit = yield* tool
        .execute({ url: "http://169.254.169.254/latest/meta-data/", format: "markdown" }, askingCtx)
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.pretty(exit.cause)).toContain("SSRF protection")
      }
      expect(asks.length).toBe(0)
    }),
  )

  it.instance("fetches a public URL and still asks for permission", () =>
    withFetch(
      () => new Response("public content", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
      (url) =>
        Effect.gen(function* () {
          const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const askingCtx: Tool.Context = {
            ...ctx,
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
          }
          const info = yield* WebFetchTool
          const tool = yield* info.init()
          const target = new URL("/public.txt", url).toString()
          const result = yield* tool.execute({ url: target, format: "text" }, askingCtx)
          expect(result.output).toBe("public content")
          expect(asks.length).toBe(1)
          expect(asks[0].permission).toBe("webfetch")
          expect(asks[0].patterns).toEqual([target])
        }),
    ),
  )

  it.instance("follows a redirect to another safe address (post-redirect guard passes)", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("landed", { status: 200 }) })),
      (targetServer) =>
        withFetch(
          () => new Response(null, { status: 302, headers: { location: targetServer.url.toString() } }),
          (redirectUrl) =>
            Effect.gen(function* () {
              const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const askingCtx: Tool.Context = {
                ...ctx,
                ask: (input) =>
                  Effect.sync(() => {
                    asks.push(input)
                  }),
              }
              const info = yield* WebFetchTool
              const tool = yield* info.init()
              const result = yield* tool.execute({ url: redirectUrl.toString(), format: "text" }, askingCtx)
              expect(result.output).toBe("landed")
              expect(asks.length).toBe(1)
            }),
        ),
      (targetServer) => Effect.sync(() => targetServer.stop(true)),
    ),
  )
})
