// @ts-nocheck
// packages/core/src/v1/config/config.ts:283-294 defined
// the memory struct with disable_write + cc_index but was missing
// embedding. memory.embedding was silently dropped by the opencode
// loader's ConfigV1.Info schema (with onExcessProperty: "ignore" in
// packages/opencode/src/config/parse.ts:42), so the embedding-check
// handler saw `cfg.memory = {}` even with the user's intent on disk.
// This test pins the v1 schema fix: a hordecode.jsonc with all three
// memory.* booleans survives ConfigParse.schema(ConfigV1.Info, ...) so
// the merged config the runtime sees carries them through.
import { test, expect, describe } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"

describe("memory schema in v1 config", () => {
  test("memory.embedding survives ConfigParse.schema(ConfigV1.Info, ...) (opencode loader entry point)", () => {
    const file = "hordecode.jsonc"
    const jsonc = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      memory: { embedding: true, disable_write: true, cc_index: true },
    })
    const parsed = ConfigParse.jsonc(jsonc, file)
    const data = ConfigParse.schema(ConfigV1.Info, parsed, file)

    // Pin each boolean at the exact loader entry point. If a future PR
    // drops one, or the schema walker skips it, the onExcessProperty
    // ignore policy in parse.ts:42 would silently truncate it.
    expect((data as { memory?: { embedding?: boolean } }).memory?.embedding).toBe(true)
    expect((data as { memory?: { disable_write?: boolean } }).memory?.disable_write).toBe(true)
    expect((data as { memory?: { cc_index?: boolean } }).memory?.cc_index).toBe(true)
  })

  test("v1 memory schema explicitly declares embedding alongside disable_write and cc_index", () => {
    // Source-level pin so the schema field stays in lockstep with the
    // three keys the runtime consumers (memory/service.ts, memory
    // search/status) rely on. Same shape as packages/core/src/config/
    // config.ts:352-355.
    const src =
      require("fs").readFileSync(
        require("path").resolve(import.meta.dir, "../../../core/src/v1/config/config.ts"),
        "utf-8",
      )
    expect(src).toMatch(/memory:\s*Schema\.optional\([\s\S]*?disable_write[\s\S]*?cc_index[\s\S]*?embedding:\s*Schema\.optional\(Schema\.Boolean\)/)
  })
})
