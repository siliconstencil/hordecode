import { afterAll, describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import type { Definition } from "./rpc-worker.fixture"

// Runs the real worker transport: Rpc.listen inside a Worker, Rpc.client on this thread.
const worker = new Worker(new URL("./rpc-worker.fixture.ts", import.meta.url).href)
const client = Rpc.client<Definition>(worker)

afterAll(() => worker.terminate())

describe("Rpc", () => {
  test("a call resolves with the method result", async () => {
    expect(await client.call("add", { a: 2, b: 3 })).toBe(5)
  })

  test("concurrent calls are answered independently, whatever order they finish in", async () => {
    const [slow, fast] = await Promise.all([
      client.call("slow", { ms: 80, value: "slow" }),
      client.call("slow", { ms: 1, value: "fast" }),
    ])
    expect([slow, fast]).toEqual(["slow", "fast"])
  })

  test("a method that throws rejects the caller instead of leaving it waiting", async () => {
    await expect(client.call("boom", undefined)).rejects.toThrow("boom")
    await expect(client.call("rejects", undefined)).rejects.toThrow("async boom")
  })

  test("an error without a message reports the text kept on its cause", async () => {
    await expect(client.call("emptyWithCause", undefined)).rejects.toThrow("port 4096 is in use")
  })

  test("an unregistered method rejects with its name", async () => {
    const call = client.call as unknown as (method: string, input: unknown) => Promise<unknown>
    await expect(call("nope", undefined)).rejects.toThrow("unregistered method: nope")
  })

  test("the worker keeps serving after a failed call", async () => {
    await expect(client.call("boom", undefined)).rejects.toThrow()
    expect(await client.call("add", { a: 1, b: 1 })).toBe(2)
  })

  test("events emitted by the worker reach subscribers until they unsubscribe", async () => {
    const seen: unknown[] = []
    const off = client.on<{ n: number }>("tick", (data) => seen.push(data))
    await client.call("announce", { event: "tick", data: { n: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    off()
    await client.call("announce", { event: "tick", data: { n: 2 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([{ n: 1 }])
  })
})
