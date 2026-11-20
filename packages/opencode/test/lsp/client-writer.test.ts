import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { PassThrough, Writable } from "stream"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { createStreamWriter } from "@/lsp/client"

const message = { jsonrpc: "2.0" as const, method: "test/ping" }

describe("LSP client message writer", () => {
  test("a write after dispose is swallowed", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      // Baseline: jsonrpc's raw writer rejects the same write.
      const raw = new StreamMessageWriter(destroyedStream())
      await expect(raw.write(message)).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" })
      raw.dispose()

      const writer = createStreamWriter(destroyedStream())
      writer.dispose()

      await expect(writer.write(message)).resolves.toBeUndefined()
      await Bun.sleep(20)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("a write after process exit is swallowed", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "pipe" })
    await new Promise<void>((resolve) => child.once("close", () => resolve()))
    child.stdin.on("error", () => {})
    child.stdin.destroy()

    const writer = createStreamWriter(child.stdin, child)
    await expect(writer.write(message)).resolves.toBeUndefined()
    writer.dispose()
  })

  test("a write to a destroyed stream resolves and closes the connection", async () => {
    const stream = new PassThrough()
    const writer = createStreamWriter(stream)
    const errors: Error[] = []
    const closes: number[] = []
    writer.onError((event) => errors.push(event[0]))
    writer.onClose(() => closes.push(1))

    stream.destroy(Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }))
    await expect(writer.write(message)).resolves.toBeUndefined()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe("Cannot call write after a stream was destroyed")
    expect((errors[0] as Error & { code?: string }).code).toBe("ERR_STREAM_DESTROYED")
    expect(closes).toHaveLength(1)

    await expect(writer.write(message)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(closes).toHaveLength(1)
    writer.dispose()
  })

  test("a pending request rejects to its caller when the stream is destroyed", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    const writeSide = new PassThrough()
    const readSide = new PassThrough()
    const connection = createMessageConnection(
      new StreamMessageReader(readSide),
      createStreamWriter(writeSide),
    )
    try {
      connection.listen()
      // Mirrors client.ts: jsonrpc leaves pending requests pending on a
      // transport close, so disposing on close is what rejects them.
      connection.onClose(() => connection.dispose())

      const settled = connection.sendRequest("test/never", {}).then(
        (value) => ({ status: "resolved" as const, value }),
        (error: { code?: number; message?: string }) => ({ status: "rejected" as const, error }),
      )
      await Bun.sleep(20)
      expect(connection.hasPendingResponse()).toBe(true)

      writeSide.destroy(Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }))
      const outcome = await settled

      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") {
        expect(outcome.error.code).toBe(-32097)
        expect(outcome.error.message).toContain("Pending response rejected")
      }
      expect(connection.hasPendingResponse()).toBe(false)
      await Bun.sleep(20)
      expect(unhandled).toEqual([])
    } finally {
      connection.dispose()
      readSide.destroy()
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("a non-dispose write error still surfaces", async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write failed"), { code: "EPIPE" }))
      },
    })
    const writer = createStreamWriter(writable)
    await expect(writer.write(message)).rejects.toMatchObject({ code: "EPIPE" })
    writer.dispose()
    writable.destroy()
  })
})

function destroyedStream() {
  const stream = new PassThrough()
  stream.destroy()
  return stream
}
