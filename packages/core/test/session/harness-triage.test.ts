import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { classifyRequest, requestText, triageSection, DEFAULT_TRIAGE_LIMITS } from "../../src/session/harness-triage"
import { applyHarnessInjection } from "../../src/session/harness-injection"

const routine = (text: string) => expect(classifyRequest(text).class).toBe("routine")
const complex = (text: string) => expect(classifyRequest(text).class).toBe("complex")

describe("harness triage classifier", () => {
  test("a short request that names one file is routine", () => {
    routine("Fix the off-by-one in src/util/range.ts: range(0) should return an empty list.")
    routine("Rename the helper `parseHeader` to `readHeader` in parser.ts")
  })

  test("a short request with a code reference but no file is routine", () => {
    routine("make `retryDelay` return 0 when attempts is 0")
  })

  test("length above the limit is complex", () => {
    const base = "Fix the bug in src/a.ts "
    routine(base.padEnd(DEFAULT_TRIAGE_LIMITS.maxChars, "x"))
    complex(base.padEnd(DEFAULT_TRIAGE_LIMITS.maxChars + 1, "x"))
  })

  test("more named files than the limit is complex", () => {
    routine("update a.ts, b.ts and c.ts to use the new name")
    complex("update a.ts, b.ts, c.ts and d.ts to use the new name")
    complex("fix the failing import in packages/core/src/ and packages/opencode/src/ and docs/ and scripts/")
  })

  test("the same file named twice counts once and urls are not files", () => {
    routine("In src/a.ts fix the typo, then check src/a.ts again; see https://example.com/docs/guide.md")
  })

  test("an explicit plan or design request is complex", () => {
    complex("Make a plan to add retry to src/net/client.ts")
    complex("Design the cache layer for src/store.ts")
    complex("Refactor src/store.ts to use the new interface")
    complex("run the full pipeline on src/store.ts")
  })

  test("a breadth word is complex", () => {
    complex("Rename parseHeader to readHeader everywhere in packages/core/src/")
    complex("Fix the lint warning in src/a.ts across the codebase")
    complex("update all the callers of `loadConfig`")
    routine("Rename parseHeader to readHeader in src/a.ts")
  })

  test("three or more list items are complex", () => {
    complex("Do these in src/a.ts:\n1. add x\n2. add y\n3. add z")
    complex("In src/a.ts:\n- add x\n- add y\n- add z")
    routine("In src/a.ts:\n- add x\n- add y")
  })

  test("a request with no file and no code reference is complex (unknown scope)", () => {
    complex("make the app faster")
    complex("and/or make it simpler")
    complex("")
    complex("   \n  ")
  })

  test("signals name what decided the class", () => {
    expect(classifyRequest("make the app faster").signals).toContain("no file or code reference")
    expect(classifyRequest("Design src/a.ts").signals.some((s) => s.startsWith("plan request"))).toBe(true)
    expect(classifyRequest("Fix src/a.ts").signals).toEqual(["length 12 <= 600", "files 1 <= 3", "no plan request"])
  })

  test("limits are parameters", () => {
    expect(classifyRequest("fix a.ts and b.ts", { ...DEFAULT_TRIAGE_LIMITS, maxFiles: 1 }).class).toBe("complex")
  })
})

describe("requestText", () => {
  const msg = (role: string, parts: any[]) => ({ info: { role }, parts })
  test("takes the last user message that has a real text part", () => {
    const msgs = [
      msg("user", [{ type: "text", text: "first request" }]),
      msg("assistant", [{ type: "text", text: "done" }]),
      msg("user", [{ type: "text", text: "injected", synthetic: true }]),
    ]
    expect(requestText(msgs)).toBe("first request")
  })

  test("ignores synthetic and ignored parts and joins the rest", () => {
    const msgs = [
      msg("user", [
        { type: "text", text: "reminder", synthetic: true },
        { type: "text", text: "fix a.ts" },
        { type: "text", text: "hidden", ignored: true },
        { type: "file" },
        { type: "text", text: "now" },
      ]),
    ]
    expect(requestText(msgs)).toBe("fix a.ts\nnow")
  })

  test("is empty without a user request", () => {
    expect(requestText([])).toBe("")
    expect(requestText([msg("assistant", [{ type: "text", text: "x" }])])).toBe("")
  })
})

describe("triage section", () => {
  test("a complex request adds nothing", () => {
    expect(triageSection(classifyRequest("make the app faster"))).toBe("")
  })

  test("a routine request tells the agent to skip brainstorm, plan and tdd and go to execute and verify", () => {
    const text = triageSection(classifyRequest("Fix src/a.ts"))
    expect(text).toContain("Do not run harness:brainstorm, harness:plan or harness:tdd")
    expect(text).toContain("harness:execute")
    expect(text).toContain("harness:verify")
  })
})

describe("harness injection with triage", () => {
  const run = async (request: string, cfg: object, agent: object = { name: "harness", skillPipeline: "harness" }) => {
    const msgs: any[] = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } },
        parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: request }],
      },
    ]
    const ctx: any = { directory: "/w", worktree: "/w", project: {} }
    await Effect.runPromise(applyHarnessInjection(msgs, agent as any, cfg as any, ctx))
    return msgs[0].parts[0].text as string
  }
  const ROUTINE = "Fix the off-by-one in src/util/range.ts"
  const COMPLEX = "make the app faster"

  test("off means unchanged: missing, empty and false configs produce the same prompt, with no triage text", async () => {
    const base = await run(ROUTINE, {})
    expect(base).toContain("Pipeline Stage Sequence")
    expect(base).not.toContain("Triage")
    expect(await run(ROUTINE, { harness: {} })).toBe(base)
    expect(await run(ROUTINE, { harness: { triage: false } })).toBe(base)
    expect(await run(ROUTINE, { harness: { docs: "docs/harness" } })).toBe(base)
  })

  test("on with a routine request appends the section and leaves the rest byte-identical", async () => {
    const off = await run(ROUTINE, {})
    const on = await run(ROUTINE, { harness: { triage: true } })
    expect(on.startsWith(off)).toBe(true)
    expect(on.slice(off.length)).toBe(triageSection(classifyRequest(ROUTINE)))
    expect(on).toContain("Triage: routine request")
  })

  test("on with a complex request leaves the prompt unchanged", async () => {
    expect(await run(COMPLEX, { harness: { triage: true } })).toBe(await run(COMPLEX, {}))
  })

  test("the research agent is never triaged", async () => {
    const agent = { name: "research", skillPipeline: "research" }
    expect(await run(ROUTINE, { harness: { triage: true } }, agent)).toBe(await run(ROUTINE, {}, agent))
  })

  test("the request is the latest real user message, not a synthetic reminder after it", async () => {
    const msgs: any[] = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } },
        parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: ROUTINE }],
      },
      {
        info: { id: "msg_2", sessionID: "ses_1", role: "user", time: { created: 2 } },
        parts: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "x".repeat(2000), synthetic: true }],
      },
    ]
    const ctx: any = { directory: "/w", worktree: "/w", project: {} }
    await Effect.runPromise(applyHarnessInjection(msgs, { name: "harness", skillPipeline: "harness" } as any, { harness: { triage: true } } as any, ctx))
    expect(msgs[1].parts[0].text).toContain("Triage: routine request")
  })
})
