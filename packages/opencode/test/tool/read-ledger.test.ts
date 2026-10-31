import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ReadLedger } from "../../src/tool/read-ledger"
import { assertFileRead } from "../../src/tool/read-state"

let dir: string
let file: string
const sid = "ses_ledger_test"
const ctx = (messages: unknown[] = []) => ({ sessionID: sid, messages }) as never

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-ledger-")))
  file = path.join(dir, "a.txt")
  writeFileSync(file, "one\n")
  ReadLedger.clear(sid)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const recordRead = () => ReadLedger.note({ sessionID: sid, tool: "read", args: { filePath: file } })

describe("read ledger", () => {
  test("a read recorded in the ledger satisfies the edit gate without any message history", () => {
    recordRead()
    expect(() => assertFileRead(ctx([]), file, "edit")).not.toThrow()
  })

  test("a write is recorded, so write-then-edit is allowed", () => {
    ReadLedger.note({ sessionID: sid, tool: "write", args: { filePath: file, content: "one\n" } })
    expect(() => assertFileRead(ctx([]), file, "edit")).not.toThrow()
  })

  test("an edit refreshes the record, so consecutive edits are allowed", () => {
    recordRead()
    writeFileSync(file, "one\ntwo\n")
    ReadLedger.note({ sessionID: sid, tool: "edit", args: { filePath: file, oldString: "one", newString: "one" } })
    expect(() => assertFileRead(ctx([]), file, "edit")).not.toThrow()
  })

  test("a file changed on disk since the read is refused with an accurate message", () => {
    recordRead()
    writeFileSync(file, "changed elsewhere\n")
    expect(() => assertFileRead(ctx([]), file, "edit")).toThrow("changed on disk since it was last read or written")
  })

  test("a changed mtime alone is enough to refuse", () => {
    recordRead()
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    expect(() => assertFileRead(ctx([]), file, "edit")).toThrow("changed on disk")
  })

  test("a changed file still blocks even when an old read call is in the conversation", () => {
    recordRead()
    writeFileSync(file, "changed elsewhere\n")
    const messages = [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: file } } }] }]
    expect(() => assertFileRead(ctx(messages), file, "edit")).toThrow("changed on disk")
  })

  test("a file never recorded falls back to the conversation scan and keeps the original message", () => {
    expect(() => assertFileRead(ctx([]), file, "edit")).toThrow("has not been read in this conversation")
    const messages = [{ parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: file } } }] }]
    expect(() => assertFileRead(ctx(messages), file, "edit")).not.toThrow()
  })

  test("ledgers are per session", () => {
    recordRead()
    expect(() => assertFileRead({ sessionID: "ses_other", messages: [] } as never, file, "edit")).toThrow(
      "has not been read",
    )
  })

  test("other tools and unreadable paths record nothing", () => {
    ReadLedger.note({ sessionID: sid, tool: "grep", args: { filePath: file } })
    ReadLedger.note({ sessionID: sid, tool: "read", args: { filePath: path.join(dir, "missing.txt") } })
    ReadLedger.note({ sessionID: sid, tool: "read", args: undefined })
    expect(ReadLedger.check(sid, file)).toBe("unknown")
    expect(ReadLedger.check(sid, path.join(dir, "missing.txt"))).toBe("unknown")
  })

  test("a file deleted after the read is left to the tool's own not-found error", () => {
    recordRead()
    rmSync(file)
    expect(ReadLedger.check(sid, file)).toBe("current")
  })
})
