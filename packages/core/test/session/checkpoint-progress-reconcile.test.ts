// Checkpoint-progress behavioral-reconcile behavioral coverage.
//
// Behavioral coverage: checkpoint-progress-reconcile behavioral coverage.
// 21 tests across 6 describe blocks, exercising fork's prod code
// `packages/core/src/session/checkpoint-progress-reconcile.ts` which ships the same
// exports (parseWrittenAt, parseReconciledMap, buildProgressDiffItems,
// renderProgressDiffBlock, buildProgressDiff) with byte-identical semantics --
// this test asserts all behavioral assertions 1:1, adapted only to fork's
// storage paths and a tmpdir redirect for Global.Path.memory (per the
// existing pattern in checkpoint-watermark-transactional.test.ts).
//
// Why it matters: buildProgressDiffItems is the "subagent progress to
// integrate" injection that lands in the checkpoint-writer's prompt on every
// spawn. A broken parseWrittenAt silently drops subagent progress, which then
// never reconciles into the main checkpoint -- the "subagent did real work
// but main doesn't know about it" class of regression.
//
// Test layout: 4 pure-function describe blocks for parseWrittenAt /
// parseReconciledMap / renderProgressDiffBlock (no DB, no file I/O) +
// 3 file-based describe blocks for buildProgressDiffItems / buildProgressDiff
// / composeWriterPrompt progressDiff injection. All 21 tests exercise these behaviors.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { checkpointPath, tasksDir, progressPath } from "@opencode-ai/core/session/checkpoint-paths"
import { SessionID } from "@opencode-ai/core/session/schema"
import {
  parseWrittenAt,
  parseReconciledMap,
  buildProgressDiffItems,
  renderProgressDiffBlock,
  buildProgressDiff,
} from "@opencode-ai/core/session/checkpoint-progress-reconcile"

// Redirect Global.Path.memory to a tmpdir so progress.md files written
// under <tmp>/sessions/<sid>/tasks/<tid>/progress.md don't leak into the
// real hordecode state. Object.assign mutates in place (Global.Path.memory
// is a frozen object but its `memory` property is not -- per Global
// it.iife shape). afterAll restores the original to keep tests isolated.
const originalMemory = Global.Path.memory
let tmpHome = ""
let prevCwd = process.cwd()

async function withTmpHome<T>(fn: (sid: SessionID) => Promise<T>): Promise<T> {
  // Re-resolve tmpHome each call so consecutive tests get isolated dirs.
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "p795-progress-reconcile-"))
  ;(Global.Path as { memory: string }).memory = tmpHome
  const sid = SessionID.make(`ses_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(tasksDir(sid), { recursive: true })
  try {
    return await fn(sid)
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeProgress(sid: SessionID, tid: string, body: string): Promise<void> {
  const fp = progressPath(sid, tid)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await Bun.write(fp, body)
}

async function writeMain(sid: SessionID, body: string): Promise<void> {
  const fp = checkpointPath(sid)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await Bun.write(fp, body)
}

describe("parseWrittenAt", () => {
  test("returns null when no frontmatter", () => {
    expect(parseWrittenAt("## §1 Task identity\n...\n")).toBeNull()
  })
  test("returns null when frontmatter lacks written-at", () => {
    expect(parseWrittenAt("---\nfoo: bar\n---\n## §1\n")).toBeNull()
  })
  test("returns number when present", () => {
    expect(parseWrittenAt("---\nwritten-at: 1717000050\n---\nbody")).toBe(1717000050)
  })
  test("returns null when value non-numeric", () => {
    expect(parseWrittenAt("---\nwritten-at: oops\n---\nbody")).toBeNull()
  })
})

describe("parseReconciledMap", () => {
  test("empty main returns empty map", () => {
    expect(parseReconciledMap("").size).toBe(0)
  })
  test("parses single §4 marker", () => {
    const main =
      "## §4 Task tree\n" +
      "🔵 T4 type checker (progress: tasks/T4/progress.md, last-reconciled-written-at: 1717000050)\n"
    const m = parseReconciledMap(main)
    expect(m.get("T4")).toBe(1717000050)
  })
  test("parses multiple markers", () => {
    const main =
      "🔵 T1 a (progress: tasks/T1/progress.md, last-reconciled-written-at: 100)\n" +
      "✅ T2 b (progress: tasks/T2/progress.md, last-reconciled-written-at: 200)\n"
    const m = parseReconciledMap(main)
    expect(m.get("T1")).toBe(100)
    expect(m.get("T2")).toBe(200)
  })
  test("ignores lines without full marker", () => {
    const main =
      "🔵 T1 a (progress: tasks/T1/progress.md)\n" +
      "✅ T2 b (progress: tasks/T2/progress.md, last-reconciled-written-at: 200)\n"
    const m = parseReconciledMap(main)
    expect(m.size).toBe(1)
    expect(m.get("T2")).toBe(200)
  })
})

describe("renderProgressDiffBlock", () => {
  test("empty items -> empty string", () => {
    expect(renderProgressDiffBlock([])).toBe("")
  })
  test("single NEW item", () => {
    const out = renderProgressDiffBlock([{ taskId: "T4", writtenAt: 100, status: "NEW" }])
    expect(out).toContain("SUBAGENT PROGRESS to integrate")
    expect(out).toContain("T4 (NEW, written-at=100)")
  })
  test("CHANGED item shows prior", () => {
    const out = renderProgressDiffBlock([
      { taskId: "T4", writtenAt: 200, status: "CHANGED", prior: 100 },
    ])
    expect(out).toContain("T4 (CHANGED, written-at=200, prior=100)")
  })
})

describe("buildProgressDiffItems", () => {
  test("empty tasks dir -> no items", async () => {
    await withTmpHome(async (sid) => {
      const items = await buildProgressDiffItems(sid)
      expect(items).toEqual([])
    })
  })

  test("single NEW (no §4 marker in main)", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(sid, "## §4 Task tree\n(none)\n")
      await writeProgress(sid, "T4", "---\nwritten-at: 100\n---\n## §1\n")
      const items = await buildProgressDiffItems(sid)
      expect(items).toEqual([{ taskId: "T4", writtenAt: 100, status: "NEW" }])
    })
  })

  test("CHANGED when written-at > prior", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(
        sid,
        "🔵 T4 a (progress: tasks/T4/progress.md, last-reconciled-written-at: 100)\n",
      )
      await writeProgress(sid, "T4", "---\nwritten-at: 200\n---\nbody")
      const items = await buildProgressDiffItems(sid)
      expect(items).toEqual([{ taskId: "T4", writtenAt: 200, status: "CHANGED", prior: 100 }])
    })
  })

  test("UNCHANGED when written-at <= prior", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(
        sid,
        "🔵 T4 a (progress: tasks/T4/progress.md, last-reconciled-written-at: 100)\n",
      )
      await writeProgress(sid, "T4", "---\nwritten-at: 100\n---\nbody")
      const items = await buildProgressDiffItems(sid)
      expect(items).toEqual([])
    })
  })

  test("missing frontmatter (splitover-authored) is skipped", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(sid, "## §4 Task tree\n(none)\n")
      await writeProgress(sid, "T4", "## §1 Task identity\nno frontmatter\n")
      const items = await buildProgressDiffItems(sid)
      expect(items).toEqual([])
    })
  })

  test("mixed NEW + CHANGED + UNCHANGED + skip", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(
        sid,
        "🔵 T2 (progress: tasks/T2/progress.md, last-reconciled-written-at: 50)\n" +
          "🔵 T3 (progress: tasks/T3/progress.md, last-reconciled-written-at: 200)\n",
      )
      await writeProgress(sid, "T1", "---\nwritten-at: 10\n---\nNEW")
      await writeProgress(sid, "T2", "---\nwritten-at: 100\n---\nCHANGED 50->100")
      await writeProgress(sid, "T3", "---\nwritten-at: 200\n---\nUNCHANGED")
      await writeProgress(sid, "T4", "## §1 no frontmatter\n")
      const items = await buildProgressDiffItems(sid)
      const sorted = [...items].sort((a, b) => a.taskId.localeCompare(b.taskId))
      expect(sorted).toEqual([
        { taskId: "T1", writtenAt: 10, status: "NEW" },
        { taskId: "T2", writtenAt: 100, status: "CHANGED", prior: 50 },
      ])
    })
  })
})

describe("buildProgressDiff (integration)", () => {
  test("empty when nothing to reconcile", async () => {
    await withTmpHome(async (sid) => {
      expect(await buildProgressDiff(sid)).toBe("")
    })
  })

  test("renders block when items exist", async () => {
    await withTmpHome(async (sid) => {
      await writeMain(sid, "## §4 Task tree\n(none)\n")
      await writeProgress(sid, "T4", "---\nwritten-at: 100\n---\nbody")
      const out = await buildProgressDiff(sid)
      expect(out).toContain("SUBAGENT PROGRESS to integrate")
      expect(out).toContain("T4 (NEW, written-at=100)")
    })
  })
})

describe("composeWriterPrompt progressDiff injection", () => {
  test("includes progress diff block in prompt when non-empty", async () => {
    const { composeWriterPromptForTest } = await import("@opencode-ai/core/session/checkpoint")
    const prompt = composeWriterPromptForTest({
      checkpointFile: "/x/checkpoint.md",
      memoryFile: "/x/memory.md",
      taskMemDir: "/x/tasks",
      notesFile: "/x/notes.md",
      rangeDesc: "test range",
      progressDiff: "SUBAGENT PROGRESS to integrate:\n  - T4 (NEW, written-at=100)",
    })
    expect(prompt).toContain("SUBAGENT PROGRESS to integrate")
    expect(prompt).toContain("T4 (NEW, written-at=100)")
  })

  test("no-op when progressDiff is empty", async () => {
    const { composeWriterPromptForTest } = await import("@opencode-ai/core/session/checkpoint")
    const prompt = composeWriterPromptForTest({
      checkpointFile: "/x/checkpoint.md",
      memoryFile: "/x/memory.md",
      taskMemDir: "/x/tasks",
      notesFile: "/x/notes.md",
      rangeDesc: "test range",
      progressDiff: "",
    })
    expect(prompt).not.toContain("SUBAGENT PROGRESS to integrate")
  })
})

// Restore Global.Path.memory after the suite. without this, a test failure
// mid-suite could leak the tmpdir path into a later test in the same process.
afterAll(() => {
  ;(Global.Path as { memory: string }).memory = originalMemory
})
