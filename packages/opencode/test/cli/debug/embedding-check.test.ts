// @ts-nocheck
// The embedding-check debug command previously exited before the
// background embedding fiber ran tryInit, so with `memory.embedding: true`
// on a cold cache it always printed available=false and no model was
// downloaded (two cold runs, 1.5s each, cache/models stayed 0 bytes). The
// fix added a wait loop on the EmbeddingService.state accessor; here we
// only pin the disabled path (the only piece that does NOT depend on a
// 120s model download) -- the enabled path is verified end-to-end in
// DONE.md with a real `hordecode debug embedding-check` invocation.
import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"

const DEBUG_TS = path.resolve(import.meta.dir, "../../../src/cli/cmd/debug/index.ts")

describe("debug embedding-check", () => {
  test("disabled path source-level pin: handler reads cfg.memory.embedding and emits DISABLED", async () => {
    // The disabled path is a fast, deterministic branch. Pin its source
    // shape so a refactor that removes the gate or renames the DISABLED
    // marker string fails this test.
    const source = await fs.readFile(DEBUG_TS, "utf-8")
    expect(source).toMatch(/cfg\.memory\?\.embedding\s*===\s*true/)
    // Disabled marker must be present and stable for downstream tooling.
    expect(source).toContain("DISABLED (memory.embedding is false)")
    // The disabled JSON shape (available:false, state:"disabled").
    expect(source).toMatch(/state:\s*"disabled"/)
  })
})
