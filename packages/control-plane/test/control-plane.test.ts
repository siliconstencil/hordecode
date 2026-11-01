import { describe, expect, test } from "bun:test"
import { GlobalBus } from "@opencode-ai/bus/global"
import { parseSSE } from "../src/sse"
import { waitEvent } from "../src/util"
import { WorkspaceContext } from "../src/workspace-context"
import { WorkspaceID } from "../src/schema"
import { WorkspaceInfo } from "../src/types"

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
      controller.close()
    },
  })

const collect = async (...chunks: string[]) => {
  const events: unknown[] = []
  await parseSSE(stream(...chunks), new AbortController().signal, (event) => events.push(event))
  return events
}

describe("parseSSE", () => {
  test("parses JSON data events", async () => {
    expect(await collect('data: {"type":"a","n":1}\n\ndata: {"type":"b"}\n\n')).toEqual([{ type: "a", n: 1 }, { type: "b" }])
  })

  test("reassembles an event split across chunks and accepts CRLF", async () => {
    expect(await collect('data: {"type":', '"a"}\r\n\r\n')).toEqual([{ type: "a" }])
  })

  test("joins multi-line data and ignores comment-only blocks", async () => {
    expect(await collect(": keepalive\n\ndata: {\ndata: \"type\": \"a\"\ndata: }\n\n")).toEqual([{ type: "a" }])
  })

  test("non-JSON data becomes an sse.message carrying id and retry", async () => {
    expect(await collect("id: 7\nretry: 2500\ndata: hello\n\n")).toEqual([
      { type: "sse.message", properties: { data: "hello", id: "7", retry: 2500 } },
    ])
  })

  test("a trailing event without the blank-line terminator is not delivered", async () => {
    expect(await collect('data: {"type":"a"}')).toEqual([])
  })

  test("an aborted signal stops reading", async () => {
    const abort = new AbortController()
    abort.abort()
    const events: unknown[] = []
    await parseSSE(stream('data: {"type":"a"}\n\n'), abort.signal, (event) => events.push(event))
    expect(events).toEqual([])
  })
})

describe("waitEvent", () => {
  const event = (type: string) => ({ directory: "/d", payload: { type } })

  test("resolves on the first matching global event and removes its listener", async () => {
    const before = GlobalBus.listenerCount("event")
    const waiting = waitEvent({ timeout: 1000, fn: (e) => e.payload.type === "wanted" })
    GlobalBus.emit("event", event("other"))
    GlobalBus.emit("event", event("wanted"))
    await waiting
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })

  test("rejects when no event matches in time", async () => {
    await expect(waitEvent({ timeout: 20, fn: () => false })).rejects.toThrow("Timed out waiting for global event")
  })

  test("rejects when the predicate throws", async () => {
    const waiting = waitEvent({
      timeout: 1000,
      fn: () => {
        throw new Error("bad predicate")
      },
    })
    GlobalBus.emit("event", event("x"))
    await expect(waiting).rejects.toThrow("bad predicate")
  })

  test("rejects immediately for an already aborted signal and on a later abort", async () => {
    const done = new AbortController()
    done.abort(new Error("gone"))
    await expect(waitEvent({ timeout: 1000, signal: done.signal, fn: () => true })).rejects.toThrow("gone")

    const later = new AbortController()
    const before = GlobalBus.listenerCount("event")
    const waiting = waitEvent({ timeout: 1000, signal: later.signal, fn: () => false })
    later.abort()
    await expect(waiting).rejects.toThrow()
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })
})

describe("WorkspaceContext", () => {
  test("is undefined outside a provided context and visible inside it", async () => {
    const id = WorkspaceID.ascending()
    expect(WorkspaceContext.workspaceID).toBeUndefined()
    const seen = await WorkspaceContext.provide({ workspaceID: id, fn: () => WorkspaceContext.workspaceID })
    expect(seen).toBe(id)
    expect(WorkspaceContext.restore(id, () => WorkspaceContext.workspaceID)).toBe(id)
  })
})

describe("workspace ids and info", () => {
  test("ascending ids carry the workspace prefix and sort by creation", () => {
    const ids = Array.from({ length: 5 }, () => WorkspaceID.ascending())
    expect(ids.every((id) => id.startsWith("wrk"))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
  })

  test("WorkspaceInfo validates its shape", () => {
    const info = { id: WorkspaceID.ascending(), type: "worktree", name: "n", branch: null, directory: null, extra: null, projectID: "global" }
    expect(WorkspaceInfo.safeParse(info).success).toBe(true)
    expect(WorkspaceInfo.safeParse({ ...info, name: 1 }).success).toBe(false)
  })
})
