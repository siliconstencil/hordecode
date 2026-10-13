import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { writeAnchorTrace } from "../src/session/anchor-trace"

// Needle-in-haystack suite: typed schema, scored verbatim retention,
// anchor ref, hook trace, cache-boundary consumption.
// LLM-level quality delta (does the compaction agent actually emit the new
// sections) requires a live run and is a known limitation of this suite.

test("buildPrompt embeds Decisions/Rejected Options/Constraints sections", () => {
  const prompt = SessionCompaction.buildPrompt({ context: [] })
  expect(prompt).toContain("## Decisions")
  expect(prompt).toContain("## Rejected Options")
  expect(prompt).toContain("## Constraints")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("## Relevant Files")
  expect(prompt).toContain("record rejected options with the reason they were rejected")
})

test("buildPrompt carries a retained-verbatim block when provided", () => {
  const prompt = SessionCompaction.buildPrompt({ context: [], verbatim: "do not paraphrase me" })
  expect(prompt).toContain("<retained-verbatim>")
  expect(prompt).toContain("do not paraphrase me")
  expect(prompt).toContain("VERBATIM")
})

test("buildPrompt emits anchor line with cache-suffix marker", () => {
  const prompt = SessionCompaction.buildPrompt({ context: [], anchor: "session:s-123" })
  expect(prompt).toContain("session:s-123")
  expect(prompt).toContain("summary-preserved-suffix/v1")
})

test("buildPrompt with no anchor/verbatim emits no verbatim block or anchor line", () => {
  const prompt = SessionCompaction.buildPrompt({ context: [] })
  expect(prompt).not.toContain("Preserve the following high-signal content VERBATIM in the summary")
  expect(prompt).not.toContain("session state anchor")
})

test("retainVerbatim scores and orders tool errors > corrections > user text", () => {
  const lines = [
    "[User]: fix the auth bug in packages/core/src/session/session.ts around line 217",
    "[Assistant tool call]: read({path})",
    "[Tool error]: ENOENT: no such file or directory, open 'packages/core/src/session/session.ts'",
    "[User]: no, keep the session-scoped cache, do not switch to a global one",
    "[Assistant]: I will switch to a global cache.",
  ]
  const kept = SessionCompaction.retainVerbatim(lines)
  expect(kept).toBeDefined()
  const parts = kept!.split("\n")
  expect(parts[0]).toContain("[Tool error]: ENOENT")
  expect(parts[1]).toContain("[User]: no, keep the session-scoped cache")
  expect(parts[2]).toContain("[User]: fix the auth bug")
  // Needles survive (the haystack question).
  expect(kept).toContain("packages/core/src/session/session.ts")
  expect(kept).toContain("session-scoped cache")
})

test("retainVerbatim dedupes identical lines", () => {
  const lines = ["[User]: same intent", "[User]: same intent", "[Tool error]: boom"]
  const kept = SessionCompaction.retainVerbatim(lines)!
  expect(kept.split("\n")).toHaveLength(2)
  expect(kept).toContain("[Tool error]: boom")
  expect(kept).toContain("[User]: same intent")
})

test("retainVerbatim caps output at 2000 chars", () => {
  const long = "[User]: " + "x".repeat(5000)
  const lines = Array.from({ length: 20 }, () => long)
  const kept = SessionCompaction.retainVerbatim(lines)!
  expect(kept.length).toBeLessThanOrEqual(2000)
})

test("retainVerbatim returns undefined on empty/noise input", () => {
  expect(SessionCompaction.retainVerbatim([])).toBeUndefined()
  expect(SessionCompaction.retainVerbatim(["[Assistant]: ok", "[System update]: boot"])).toBeUndefined()
})

test("writeAnchorTrace appends JSONL records and survives repeated writes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "anchor-trace-"))
  try {
    const ok1 = writeAnchorTrace({ sessionID: "s-1", source: "hook", taskID: "t-42", dir })
    const ok2 = writeAnchorTrace({ sessionID: "s-1", source: "hook", queueRef: "queue:12", dir })
    expect(ok1).toBe(true)
    expect(ok2).toBe(true)
    const file = readFileSync(path.join(dir, "anchor-trace.jsonl"), "utf8")
    const lines = file.trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as Record<string, unknown>
    expect(first.session_id).toBe("s-1")
    expect(first.source).toBe("hook")
    expect(first.task_id).toBe("t-42")
    expect(typeof first.created_at).toBe("number")
    const second = JSON.parse(lines[1]) as Record<string, unknown>
    expect(second.queue_ref).toBe("queue:12")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("needle-in-haystack: full prompt carries all three probes", () => {
  const conversation = [
    "[User]: migrate the session store to SQLite at packages/memory/src/store.ts",
    "[Tool error]: SQLITE_BUSY: database is locked",
    "[User]: no, do not use WAL for the prototype, keep it simple",
  ]
  const prompt = SessionCompaction.buildPrompt({
    context: conversation,
    anchor: "session:s-needle",
    verbatim: SessionCompaction.retainVerbatim(conversation),
  })
  // Probe 1: verbatim user intent
  expect(prompt).toContain("migrate the session store to SQLite")
  // Probe 2: decision-shaped correction verbatim
  expect(prompt).toContain("do not use WAL for the prototype")
  // Probe 3: file:line-style reference
  expect(prompt).toContain("packages/memory/src/store.ts")
  // Probe 4: anchor pointer present for continuation restore
  expect(prompt).toContain("session:s-needle")
})
