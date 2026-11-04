import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { modeSkillsBlock } from "@opencode-ai/skill/harness/extract"
import { classifyRequest, requestText, triageSection, DEFAULT_TRIAGE_LIMITS } from "../../src/session/harness-triage"
import { applyHarnessInjection } from "../../src/session/harness-injection"

const routine = (text: string) => expect(classifyRequest(text).class).toBe("routine")
const complex = (text: string) => expect(classifyRequest(text).class).toBe("complex")
const signalsOf = (text: string) => classifyRequest(text).signals.join(" | ")

describe("harness triage classifier: routine only for mechanical edits", () => {
  test("a one-sentence mechanical edit that names one file is routine", () => {
    routine("Fix the typo in src/util/range.ts")
    routine("Fix a spelling mistake in README.md")
    routine("Bump the version in package.json")
    routine("Remove the unused import in src/a.ts")
    routine("Update the comment in src/a.ts")
    routine("Reformat src/a.ts")
  })

  test("the false routines of the review are complex: ordinary feature and fix requests", () => {
    for (const request of [
      "Add OAuth login to src/auth.ts",
      "Implement a rate limiter in src/limiter.ts with per-user quotas",
      "Add pagination to the users endpoint in api/users.ts",
      "Add Postgres support to src/db.ts",
      "Fix the flaky test in test/a.test.ts",
      "Why is src/render.ts slow? make it faster",
      "Convert src/index.js from JavaScript to TypeScript",
      "Upgrade React to v19 in package.json",
      "Fix all the bugs in src/parser.ts",
      "Update the logger usage throughout `src` to the new API",
      "Add caching to a.ts, then update b.ts and c.ts, then write the docs and deploy",
      "Harden the auth flow in src/auth.ts against CSRF and session fixation",
      "Split src/app.ts into modules",
      "Restructure src/app.ts",
      "Add retry to src/net/client.ts and update test/net/client.test.ts",
      "Fix the off-by-one in src/util/range.ts: range(0) should return an empty list.",
      "Rename the helper `parseHeader` to `readHeader` in parser.ts",
    ]) {
      complex(request)
    }
  })

  test("an allowed shape stays complex when anything else is asked", () => {
    complex("Fix the typo in src/a.ts and add OAuth login")
    complex("Fix the typo in src/a.ts, then run the release")
    complex("Fix the typo in src/a.ts. Also add a cache.")
    complex("Fix the typo in src/a.ts and similar ones")
    complex("Fix the typo in a.ts and b.ts")
  })

  test("no file named, or no known edit, is complex (unknown scope)", () => {
    complex("make the app faster")
    complex("Fix the typo in the error message")
    complex("make `retryDelay` return 0 when attempts is 0")
    complex("and/or make it simpler")
    complex("")
    complex("   \n  ")
  })

  test("each signal decides on its own and is named", () => {
    const base = "Fix the typo in src/a.ts"
    routine(base)
    expect(signalsOf("")).toContain("empty request")
    expect(signalsOf(base.padEnd(DEFAULT_TRIAGE_LIMITS.maxChars + 1, "x"))).toContain(`length ${DEFAULT_TRIAGE_LIMITS.maxChars + 1} > ${DEFAULT_TRIAGE_LIMITS.maxChars}`)
    expect(signalsOf("Fix the typo in a.ts, b.ts")).toContain("files 2 > 1")
    expect(signalsOf("Fix the typo in src/ and docs/")).toContain("files 2 > 1")
    expect(signalsOf("Fix the typo in the message")).toContain("no file named (unknown scope)")
    expect(signalsOf(`${base}, migrate it`)).toContain('plan request "migrate"')
    expect(signalsOf(`${base}, the whole file`)).toContain('breadth word "whole"')
    expect(signalsOf(`${base} and more`)).toContain('compound request "and"')
    expect(signalsOf(`${base}.\nThanks`)).toContain("more than one line")
    expect(signalsOf(`${base}. Then stop.`)).toContain("more than one sentence")
    expect(signalsOf("Please look at src/a.ts")).toContain("not a known mechanical edit")
    expect(signalsOf(`${base}:\n- x\n- y`)).toContain("list items 2 >= 2")
  })

  test("a directory counts as a named path; a url and the same file twice do not add files", () => {
    routine("Fix the typo in packages/core/src/")
    routine("Fix the typo in src/a.ts, see https://example.com/docs/guide.md")
    routine("Fix the typo on line 3 of src/a.ts, in src/a.ts")
  })

  test("words inside a file name or url are not signals (spec, plan, design)", () => {
    routine("Fix the typo in src/util.spec.ts")
    routine("Fix the typo in docs/plan.md")
    routine("Fix the typo in design/notes.md")
    routine("Fix the typo in src/a.ts, see https://example.com/design/plan")
    complex("Fix the typo in src/a.ts, make a plan")
  })

  test("language-neutral: text that is not mostly ASCII letters is complex, whatever it names", () => {
    for (const request of [
      "修复 src/a.ts 中的拼写错误",
      "Исправь опечатку в src/a.ts",
      "src/a.ts içindeki yazım hatasını düzelt",
      "src/a.ts \u3092\u30EA\u30D5\u30A1\u30AF\u30BF\u30EA\u30F3\u30B0\u3057\u3066",
      "\uFF52\uFF45\uFF46\uFF41\uFF43\uFF54\uFF4F\uFF52 src/a.ts",
      "Fix the typo in src/a.ts \u4FEE\u590D\u62FC\u5199\u9519\u8BEF\u4FEE\u590D\u62FC\u5199\u9519\u8BEF",
    ]) {
      complex(request)
      expect(signalsOf(request)).toContain("not mostly ASCII")
    }
  })

  test("a non-English request in ASCII spelling has no known English edit shape: complex", () => {
    complex("src/onbellek.ts icinde bir onbellek katmani tasarla")
    complex("Refactorizar src/a.ts y dividirlo en modulos")
    complex("Ersetze die Funktion in src/a.ts")
  })

  test("limits are parameters", () => {
    expect(classifyRequest("Fix the typo in a.ts, b.ts", { ...DEFAULT_TRIAGE_LIMITS, maxFiles: 2 }).class).toBe("routine")
    expect(classifyRequest("Fix the typo in a.ts, b.ts").class).toBe("complex")
  })

  test("signals of a routine verdict name the shape", () => {
    expect(classifyRequest("Fix src/a.ts typo".replace("src/a.ts typo", "the typo in src/a.ts")).signals).toEqual([
      "length 24 <= 300",
      "files 1",
      'mechanical edit "fix the typo"',
    ])
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
    const text = triageSection(classifyRequest("Fix the typo in src/a.ts"))
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
  const ROUTINE = "Fix the typo in src/util/range.ts"
  const COMPLEX = "make the app faster"

  test("off means unchanged: missing, empty and false configs produce the same prompt, with no triage text", async () => {
    const base = await run(ROUTINE, {})
    expect(base).toContain("Pipeline Stage Sequence")
    expect(base).not.toContain("Triage")
    expect(await run(ROUTINE, { harness: {} })).toBe(base)
    expect(await run(ROUTINE, { harness: { triage: false } })).toBe(base)
    expect(await run(ROUTINE, { harness: { docs: "docs/harness" } })).toBe(base)
  })

  test("off is byte-identical to the triage-free injection, triage on or off for complex requests", async () => {
    // The base formula is the injection of the merged tree (the fixes-branch paths text), not the 0.1.5 one.
    const base = await run(ROUTINE, {})
    expect(base).toContain(modeSkillsBlock("harness"))
    expect(base).not.toContain("{{harness_docs_dir}}")
    expect(base).not.toContain("Triage")
    expect(await run(ROUTINE, { harness: { triage: false } })).toBe(base)
    expect(await run(COMPLEX, { harness: { triage: true } })).toBe(base)
    expect(await run("Fix the typo in src/a.ts, then add OAuth", { harness: { triage: true } })).toBe(base)
  })

  test("on with a routine request inserts the section inside the system-reminder block", async () => {
    const off = await run(ROUTINE, {})
    const on = await run(ROUTINE, { harness: { triage: true } })
    const section = triageSection(classifyRequest(ROUTINE))
    const close = off.lastIndexOf("</system-reminder>")
    expect(on).toBe(off.slice(0, close) + section + off.slice(close))
    expect(on.trimEnd().endsWith("</system-reminder>")).toBe(true)
    expect(on.indexOf("Triage: routine request")).toBeLessThan(on.lastIndexOf("</system-reminder>"))
    expect(on.replace(section, "")).toBe(off)
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
