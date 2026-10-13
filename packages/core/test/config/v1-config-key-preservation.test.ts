import { describe, expect, it } from "bun:test"
import { Exit, Schema as EffectSchema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

/**
 * Mirror of packages/opencode/src/config/parse.ts schema() decoder,
 * inlined here so this test does not depend on @opencode-ai/opencode
 * (which lives in a sibling package and is not importable from
 * packages/core without creating a reverse dependency). The
 * behaviour is byte-identical to parse.ts lines 40-42:
 *   decodeUnknownExit + onExcessProperty: "ignore" + errors: "all" +
 *   propertyOrder: "original"
 * -- the exact options the runtime uses to load config. Excess
 * properties (i.e. keys absent from the v1 Struct) are silently
 * dropped at this layer; that silent-drop class is what this guard
 * exists to catch.
 */
const decodeAsRuntime = (data: unknown): any => {
  const decoded = EffectSchema.decodeUnknownExit(ConfigV1.Info)(data, {
    errors: "all",
    onExcessProperty: "ignore",
    propertyOrder: "original",
  })
  if (Exit.isSuccess(decoded)) return decoded.value
  throw new Error("ConfigV1 decode failed (test bug, not the subject under test)")
}

/**
 * Guard test for silent config-key drops in the v1
 * schema). v1 is the RUNTIME config schema; see
 * packages/opencode/src/config/parse.ts lines 40-42
 * (`onExcessProperty: "ignore"`).
 *
 * Any dotted key the runtime reads but which is missing from v1's
 * Struct is silently discarded by `parse.ts` before the runtime
 * ever sees it. This test guards the three keys that were missing from the schema by
 * placing EVERY key the runtime currently reads
 * into a single object, decoding it through v1 with the exact
 * options parse.ts uses, and asserting each key round-trips with
 * its value intact.
 *
 * If any of the three v1 additions regresses (experimental.predict_next_prompt,
 * history.kinds, tool.invocation_style or tool.invocation_style_by_tool),
 * the corresponding assertion below will fail with the value undefined.
 *
 * Memory.embedding is intentionally NOT in this fixture -- another
 * worktree owns that key.
 */
describe("v1 config: all runtime-read keys survive decoding", () => {
  const fixture = {
    checkpoint: {
      fork: true,
      memory_reconcile_on_search: false,
      memory_search_score_floor: 0.42,
      push_caps: {
        tasks_ledger: 1111,
        focus_task: 2222,
        supervisor_ledger: 333,
        memory_titles: 444,
        global: 5555,
        checkpoint: 6666,
        memory: 7777,
        notes: 8888,
        design_decisions: 999,
        open_notes: 222,
        recent_user: 11111,
        recent_user_per_msg: 333,
      },
      reserved: 25000,
      thresholds: ["40%", "60%", "80%"],
    },
    compaction: {
      auto: true,
      max_context: 300000,
      preserve_recent_tokens: 4096,
      prune: false,
      reserved: 8192,
      tail_turns: 3,
    },
    distill: {
      auto: true,
      interval_days: 30,
    },
    dream: {
      auto: true,
      interval_days: 7,
    },
    experimental: {
      maxMode: { candidates: 5 },
      mcp_timeout: 30000,
      openTelemetry: true,
      predict_next_prompt: true,
      try_best: {
        edit_window: 0.6,
        edit_similarity: 0.85,
        edit_matches: 3,
        action_streak: 5,
        bash_retries: 2,
      },
    },
    history: {
      kinds: ["user_text", "assistant_text", "tool_input", "tool_error", "reasoning", "tool_output"],
    },
    memory: {
      cc_index: true,
      disable_write: false,
    },
    skills: {
      paths: ["/etc/hordecode/skills", "/usr/local/share/hordecode/skills"],
      urls: ["github.com/hordecode/skills", "https://example.com/hordecode-skills"],
    },
    tool: {
      invocation_style: "shell",
      invocation_style_by_tool: {
        bash: "shell",
        read: "json",
        write: "shell",
      },
    },
    watcher: {
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    },
    workflow: {
      maxConcurrentAgents: 16,
      scriptDeadlineMs: 12 * 60 * 60 * 1000,
    },
  }

  it("decodeUnknownExit with parse.ts options keeps every runtime-read key present", () => {
    const decoded = decodeAsRuntime(fixture)
    expect(decoded.checkpoint?.fork).toBe(true)
    expect(decoded.checkpoint?.memory_reconcile_on_search).toBe(false)
    expect(decoded.checkpoint?.memory_search_score_floor).toBe(0.42)
    expect(decoded.checkpoint?.push_caps?.memory).toBe(7777)
    expect(decoded.checkpoint?.push_caps?.checkpoint).toBe(6666)
    expect(decoded.checkpoint?.reserved).toBe(25000)
    expect(decoded.checkpoint?.thresholds).toEqual(["40%", "60%", "80%"])

    expect(decoded.compaction?.auto).toBe(true)
    expect(decoded.compaction?.max_context).toBe(300000)
    expect(decoded.compaction?.preserve_recent_tokens).toBe(4096)
    expect(decoded.compaction?.prune).toBe(false)
    expect(decoded.compaction?.reserved).toBe(8192)
    expect(decoded.compaction?.tail_turns).toBe(3)

    expect(decoded.distill?.auto).toBe(true)
    expect(decoded.distill?.interval_days).toBe(30)

    expect(decoded.dream?.auto).toBe(true)
    expect(decoded.dream?.interval_days).toBe(7)

    expect(decoded.experimental?.maxMode?.candidates).toBe(5)
    expect(decoded.experimental?.mcp_timeout).toBe(30000)
    expect(decoded.experimental?.openTelemetry).toBe(true)
    expect(decoded.experimental?.predict_next_prompt).toBe(true)
    expect(decoded.experimental?.try_best?.edit_window).toBe(0.6)
    expect(decoded.experimental?.try_best?.bash_retries).toBe(2)

    // The three keys added to the schema -- these are the keys the guard exists for.
    expect(decoded.history?.kinds).toEqual([
      "user_text",
      "assistant_text",
      "tool_input",
      "tool_error",
      "reasoning",
      "tool_output",
    ])
    expect(decoded.tool?.invocation_style).toBe("shell")
    expect(decoded.tool?.invocation_style_by_tool?.bash).toBe("shell")
    expect(decoded.tool?.invocation_style_by_tool?.read).toBe("json")

    expect(decoded.memory?.cc_index).toBe(true)
    expect(decoded.memory?.disable_write).toBe(false)

    expect(decoded.skills?.paths).toEqual([
      "/etc/hordecode/skills",
      "/usr/local/share/hordecode/skills",
    ])
    expect(decoded.skills?.urls).toEqual([
      "github.com/hordecode/skills",
      "https://example.com/hordecode-skills",
    ])

    expect(decoded.watcher?.ignore).toEqual(["**/node_modules/**", "**/.git/**", "**/dist/**"])

    expect(decoded.workflow?.maxConcurrentAgents).toBe(16)
    expect(decoded.workflow?.scriptDeadlineMs).toBe(12 * 60 * 60 * 1000)
  })
})
