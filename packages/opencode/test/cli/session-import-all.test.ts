import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Handoff test per task Task B brief: "run the command against temp dirs
// with 0 sources present and assert clean per-source 'scanned 0' output, no
// throw".
//
// runAll's contract (from external-import.ts:93-132): each per-source import
// is wrapped in try/catch; errors are collected into result[source].errors
// rather than thrown. This is the whole point of the aggregate wrapper.
// Per-source imports themselves return ImportStats with zeros when their
// root path does not exist on disk.
//
// How the importers resolve their roots:
//   - ClaudeImport.run()  -- external-import.ts:108 -> claude-import.ts:239:
//       root = path.join(Path.home, ".claude", "projects")
//     Path.home is packages/global/src/index.ts:13:14, a getter that reads
//     process.env.HOME || process.env.USERPROFILE || os.homedir() at access
//     time. Setting HOME in beforeAll redirects this read.
//   - CodexImport.run()   -- external-import.ts:110 -> codex-import.ts:265:
//       root = path.join(Path.home, ".codex", "sessions")
//     Same Path.home getter, same env-driven override.
//   - OpencodeImport.run() -- external-import.ts:112 -> opencode-import.ts:14-18:
//       DEFAULT_DB_PATH = ${XDG_DATA_HOME || HOME || USERPROFILE}/.local/share/opencode/opencode.db
//     DEFAULT_DB_PATH is a module-load IIFE (opencode-import.ts:14), so the
//     value is captured the first time the module is imported. We must
//     therefore do the env redirect BEFORE the first import of
//     external-import in this process -- achieved via dynamic import() inside
//     the test bodies, after beforeAll sets the env.
//
// We exercise three contract properties:
//   1. runAll() does NOT throw regardless of host filesystem state.
//   2. With sources: [singleSource], only that source runs the real import;
//      the others receive the emptyStats() placeholder.
//   3. With an empty home (no real ~/.claude/projects, ~/.codex/sessions, or
//      ~/.local/share/opencode/opencode.db), every source returns zeros
//      and zero errors -- the contract the CLI command relies on.
// The CLI command (SessionImportAllCommand) is itself exercised by the
// session.ts --help smoke (see test/cli/cli-smoke.test.ts).

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_DATA_HOME"] as const

type Module = typeof import("@opencode-ai/core/session/external-import")
let ext: Module

let emptyHome = ""
const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  HOME: undefined,
  USERPROFILE: undefined,
  XDG_DATA_HOME: undefined,
}

beforeAll(async () => {
  emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "external-import-empty-"))
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
  }
  process.env.HOME = emptyHome
  process.env.USERPROFILE = emptyHome
  process.env.XDG_DATA_HOME = path.join(emptyHome, ".local", "share")
  // Dynamic import: module-load IIFE in opencode-import.ts:14 captures
  // DEFAULT_DB_PATH = ${XDG_DATA_HOME}/opencode/opencode.db at this point,
  // so the opencode source also resolves into our empty tree.
  ext = await import("@opencode-ai/core/session/external-import")
})

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  if (emptyHome) await fs.rm(emptyHome, { recursive: true, force: true })
})

describe("ExternalImport.runAll (CLI session import wrapper)", () => {
  test("runAll with empty home: each source scans 0, no errors, no throw", async () => {
    const result = await ext.ExternalImport.runAll()
    expect(result.cc.scanned).toBe(0)
    expect(result.cc.imported).toBe(0)
    expect(result.cc.resynced).toBe(0)
    expect(result.cc.skipped).toBe(0)
    expect(result.cc.errors).toEqual([])
    expect(result.codex.scanned).toBe(0)
    expect(result.codex.imported).toBe(0)
    expect(result.codex.resynced).toBe(0)
    expect(result.codex.skipped).toBe(0)
    expect(result.codex.errors).toEqual([])
    expect(result.opencode.scanned).toBe(0)
    expect(result.opencode.imported).toBe(0)
    expect(result.opencode.resynced).toBe(0)
    expect(result.opencode.skipped).toBe(0)
    expect(result.opencode.errors).toEqual([])
  })

  test("sources: [codex] with empty home: codex runs, others get emptyStats placeholder", async () => {
    const result = await ext.ExternalImport.runAll({ sources: ["codex"] })
    // cc and opencode were never initialized via the real import path --
    // they were populated with emptyStats() at runAll entry (line 100-102)
    // and never overwritten because the loop skipped them.
    expect(result.cc.scanned).toBe(0)
    expect(result.cc.errors).toEqual([])
    expect(result.opencode.scanned).toBe(0)
    expect(result.opencode.errors).toEqual([])
    // codex ran the real import path against the empty root and returned
    // a valid ImportStats with zeros.
    expect(result.codex.scanned).toBe(0)
    expect(Array.isArray(result.codex.errors)).toBe(true)
    expect(result.codex.errors).toEqual([])
  })

  test("scan() with empty home: every source reports unavailable, 0 sessions", async () => {
    const result = await ext.ExternalImport.scan()
    expect(result.cc.available).toBe(false)
    expect(result.cc.sessions).toBe(0)
    expect(result.codex.available).toBe(false)
    expect(result.codex.sessions).toBe(0)
    expect(result.opencode.available).toBe(false)
    expect(result.opencode.sessions).toBe(0)
  })

  test("runAll with sources: [] : every source gets emptyStats placeholder, no throw", async () => {
    const result = await ext.ExternalImport.runAll({ sources: [] })
    expect(result.cc.scanned).toBe(0)
    expect(result.codex.scanned).toBe(0)
    expect(result.opencode.scanned).toBe(0)
    expect(result.cc.errors).toEqual([])
    expect(result.codex.errors).toEqual([])
    expect(result.opencode.errors).toEqual([])
  })
})
