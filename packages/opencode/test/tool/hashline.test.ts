import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Cause, Effect, Exit } from "effect"
import { HashlineEditTool, HashlineReadTool } from "../../src/tool/hashline"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { fileTag } from "../../src/tool/hashline-core"
import { RecoverableError } from "@opencode-ai/core/tool/recoverable"

const ctx = {
  sessionID: SessionID.make("ses_test-hashline-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = AppNodeBuilder.build(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const initRead = Effect.fn("HashlineTest.initRead")(function* () {
  const info = yield* HashlineReadTool
  return yield* info.init()
})

const initEdit = Effect.fn("HashlineTest.initEdit")(function* () {
  const info = yield* HashlineEditTool
  return yield* info.init()
})

const read = Effect.fn("HashlineTest.read")(function* (args: { filePath: string; offset?: number; limit?: number }) {
  const tool = yield* initRead()
  const result = yield* tool.execute(args, ctx)
  return result.output
})

const edit = Effect.fn("HashlineTest.edit")(function* (args: {
  filePath: string
  tag: string
  ops: Tool.InferParameters<typeof HashlineEditTool>["ops"]
}) {
  const tool = yield* initEdit()
  return yield* tool.execute(args, ctx)
})

const fail = <R>(run: Effect.Effect<unknown, unknown, R>) =>
  Effect.gen(function* () {
    const exit = yield* run.pipe(Effect.exit)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause)
      return err instanceof Error ? err : new Error(String(err))
    }
    throw new Error("expected hashline call to fail")
  })

const put = Effect.fn("HashlineTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const loadRaw = Effect.fn("HashlineTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const headerTag = (output: string) => {
  const match = output.match(/^\[[^\n]*#([0-9a-f]{8})\]/)
  if (!match) throw new Error(`no header in output: ${output}`)
  return match[1]
}

const newTag = (output: string) => {
  const match = output.match(/New tag: ([0-9a-f]{8})/)
  if (!match) throw new Error(`no New tag in output: ${output}`)
  return match[1]
}

describe("tool.hashline", () => {
  describe("hashline_read", () => {
    it.instance("renders header with tag and numbered rows", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "readme.txt")
        const content = "alpha\nbeta\ngamma\n"
        yield* put(filepath, content)

        const output = yield* read({ filePath: filepath })

        expect(output.split("\n")[0]).toBe(`[${filepath}#${fileTag(content)}]`)
        expect(output).toContain("1:alpha\n2:beta\n3:gamma")
      }),
    )

    it.instance("honours offset and limit and names the next offset", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "long.txt")
        yield* put(filepath, "l1\nl2\nl3\nl4\nl5\n")

        const output = yield* read({ filePath: filepath, offset: 2, limit: 2 })

        expect(output).toContain("2:l2\n3:l3")
        expect(output).not.toContain("1:l1")
        expect(output).not.toContain("4:l4")
        expect(output).toContain("(2 more lines, use offset=4)")
      }),
    )

    it.instance("refuses a binary file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "blob.dat")
        yield* put(filepath, "abc\u0000def\n")

        const err = yield* fail(read({ filePath: filepath }))
        expect(err.message).toContain("binary file")
      }),
    )

    it.instance("caps one view at 40 KB and names the next offset", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "big.txt")
        const line = "x".repeat(1000)
        yield* put(filepath, Array.from({ length: 200 }, () => line).join("\n") + "\n")

        const output = yield* read({ filePath: filepath })
        expect(Buffer.byteLength(output)).toBeLessThan(42 * 1024)
        expect(output).toMatch(/more lines, use offset=\d+\)/)
      }),
    )

    it.instance("errors when the file is missing", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "absent.txt")

        const err = yield* fail(read({ filePath: filepath }))

        expect(err.message).toBe(`File ${filepath} not found`)
      }),
    )

    it.instance("errors when the path is a directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        const fsSvc = yield* FSUtil.Service
        yield* fsSvc.makeDirectory(dirpath)

        const err = yield* fail(read({ filePath: dirpath }))

        expect(err.message).toContain("directory")
      }),
    )
  })

  describe("hashline_edit", () => {
    it.instance("applies a replace and returns the new tag of the written text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "happy.txt")
        yield* put(filepath, "one\ntwo\nthree\n")
        const tag = headerTag(yield* read({ filePath: filepath }))

        const result = yield* edit({
          filePath: filepath,
          tag,
          ops: [{ op: "replace", start: 2, lines: ["TWO"] }],
        })

        const onDisk = yield* loadRaw(filepath)
        expect(onDisk).toBe("one\nTWO\nthree\n")
        expect(result.output).toContain("Edit applied. New tag:")
        expect(newTag(result.output)).toBe(fileTag(onDisk))
        expect(newTag(result.output)).not.toBe(tag)
      }),
    )

    it.instance("chains a second edit with the returned tag without re-reading", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "chain.txt")
        yield* put(filepath, "one\ntwo\nthree\n")
        const first = yield* edit({
          filePath: filepath,
          tag: headerTag(yield* read({ filePath: filepath })),
          ops: [{ op: "replace", start: 2, lines: ["TWO"] }],
        })

        const second = yield* edit({
          filePath: filepath,
          tag: newTag(first.output),
          ops: [{ op: "insert_after", start: 3, lines: ["four"] }],
        })

        expect(yield* loadRaw(filepath)).toBe("one\nTWO\nthree\nfour\n")
        expect(newTag(second.output)).toBe(fileTag("one\nTWO\nthree\nfour\n"))
      }),
    )

    it.instance("rejects a stale tag as a recoverable error and leaves the file unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "stale.txt")
        yield* put(filepath, "one\ntwo\n")
        const tag = headerTag(yield* read({ filePath: filepath }))
        const changed = "one\nchanged on disk\n"
        yield* put(filepath, changed)

        const err = yield* fail(
          edit({ filePath: filepath, tag, ops: [{ op: "replace", start: 2, lines: ["TWO"] }] }),
        )

        expect(err).toBeInstanceOf(RecoverableError)
        expect(err.message).toContain("hashline_read")
        expect(yield* loadRaw(filepath)).toBe(changed)
      }),
    )

    it.instance("rejects overlapping ops and leaves the file unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "overlap.txt")
        const content = "one\ntwo\nthree\n"
        yield* put(filepath, content)
        const tag = headerTag(yield* read({ filePath: filepath }))

        const err = yield* fail(
          edit({
            filePath: filepath,
            tag,
            ops: [
              { op: "replace", start: 1, end: 2, lines: ["X"] },
              { op: "delete", start: 2 },
            ],
          }),
        )

        expect(err).toBeInstanceOf(RecoverableError)
        expect(err.message).toContain("overlaps")
        expect(yield* loadRaw(filepath)).toBe(content)
      }),
    )

    it.instance("keeps CRLF line endings after an edit", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        yield* put(filepath, "a\r\nb\r\nc\r\n")
        const tag = headerTag(yield* read({ filePath: filepath }))

        yield* edit({ filePath: filepath, tag, ops: [{ op: "replace", start: 2, lines: ["B"] }] })

        expect(yield* loadRaw(filepath)).toBe("a\r\nB\r\nc\r\n")
      }),
    )

    it.instance("keeps the BOM, hides it from the view, and matches the read tag", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "bom.txt")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}x\ny\n`)
        const output = yield* read({ filePath: filepath })
        const tag = headerTag(output)

        expect(output).toContain("1:x\n2:y")
        expect(tag).toBe(fileTag("x\ny\n"))

        const result = yield* edit({ filePath: filepath, tag, ops: [{ op: "replace", start: 1, lines: ["X"] }] })

        const onDisk = yield* loadRaw(filepath)
        expect(onDisk.charCodeAt(0)).toBe(0xfeff)
        expect(onDisk.slice(1)).toBe("X\ny\n")
        expect(newTag(result.output)).toBe(fileTag("X\ny\n"))
      }),
    )
  })
})
