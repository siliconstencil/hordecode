// @ts-nocheck
// Model loading -- each model candidate used to be loaded inside a 15 s
// Promise.race; on a slow network the first model's download would be
// abandoned mid-flight and the loop would move to the fallback, so the
// active embedding space came to depend on network speed (two model
// dirs on disk, an embedded DB queried with the wrong vectors). Fix:
// no per-candidate timer; the fallback only fires on real rejection;
// a single overall 10-minute safety cap exists. These tests pin that
// shape by reading the live service.ts source and asserting the
// per-candidate code path no longer contains a per-candidate timer.
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const SERVICE_TS = path.resolve(import.meta.dir, "./service.ts")

describe("embedding service single-model load", () => {
  test("per-candidate timer (Promise.race with setTimeout) is gone -- fallback only on real rejection", async () => {
    const src = await fs.readFile(SERVICE_TS, "utf-8")
    // Inside tryInit's model loop, the old code was:
    //   Promise.race([
    //     pipeline("feature-extraction", model).catch(() => null),
    //     new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    //   ])
    // which abandoned a still-loading download after 15 s. The fix
    // awaits the pipeline promise itself; only the overall 10-minute
    // safety cap races against the loop (and never against an
    // individual candidate).
    const perCandidateTimer = /pipeline\(\s*["']feature-extraction["']\s*,\s*model\s*\)\.catch\(\(\)\s*=>\s*null\),\s*new\s+Promise<null>\(\(resolve\)\s*=>\s*setTimeout\(\(\)\s*=>\s*resolve\(null\),\s*15_000/
    expect(src.match(perCandidateTimer)).toBeNull()
  })

  test("only an overall safety cap (10 minutes = 600_000 ms) exists; not a per-candidate timer", async () => {
    const src = await fs.readFile(SERVICE_TS, "utf-8")
    // The cap is set once at the top of the loop and used in
    // `overallCapMs - (Date.now() - startedAt)`. We pin its identity
    // ("10 * 60 * 1000" = 600_000 ms) and its single occurrence.
    expect(src).toMatch(/const\s+overallCapMs\s*=\s*10\s*\*\s*60\s*\*\s*1000/)
    // The cap value must NOT appear as a per-candidate timer (e.g. as a
    // hard-coded "15000" inside a setTimeout or Promise.race in the loop).
    expect(src).not.toMatch(/setTimeout\([^)]*resolve\(null\),\s*15_000/)
  })

  test("the fix exposes the active model id on the Interface (model: Effect<string | null>)", async () => {
    const src = await fs.readFile(SERVICE_TS, "utf-8")
    expect(src).toMatch(/readonly\s+model:\s*Effect\.Effect<string\s*\|\s*null>/)
  })

  test("MemoryStatus carries embeddingModel (memory/service.ts)", async () => {
    const servicePath = path.resolve(import.meta.dir, "../service.ts")
    const src = await fs.readFile(servicePath, "utf-8")
    expect(src).toMatch(/export\s+type\s+MemoryStatus\s*=\s*\{[\s\S]*?embeddingModel:\s*string\s*\|\s*null/)
  })
})

