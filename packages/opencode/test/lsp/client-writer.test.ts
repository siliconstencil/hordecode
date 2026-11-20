import { describe, expect, test } from "bun:test"
import { PassThrough, Writable } from "stream"
import { StreamMessageWriter } from "vscode-jsonrpc/node"
import { createStreamWriter } from "@/lsp/client"

const message = { jsonrpc: "2.0" as const, method: "test/ping" }

describe("LSP client message writer", () => {
  test("a write after the connection is disposed does not reject", async () => {
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
