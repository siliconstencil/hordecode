import { describe, expect, test } from "bun:test"
import { createRepetitionMonitor, degenerateStep, isToolMarkupFragment, reasoningTailRepeats } from "../../src/session/degenerate-step"

const text = (s: string) => ({ type: "text", text: s })
const reason = (s: string) => ({ type: "reasoning", text: s })
const call = (s: string, input: Record<string, unknown> = {}) => ({ type: "tool", tool: s, state: { status: "completed", input } })
const base = { finish: "stop", error: undefined }

describe("isToolMarkupFragment", () => {
  test("lone closing tag", () => expect(isToolMarkupFragment("</oldString>")).toBe(true))
  test("tag sequence without other content", () => expect(isToolMarkupFragment("</newString></item></content>")).toBe(true))
  test("opening tag with attributes", () => expect(isToolMarkupFragment('<invoke name="edit">')).toBe(true))
  test("prose is not a fragment", () => expect(isToolMarkupFragment("Done.")).toBe(false))
  test("prose around a tag is not a fragment", () => expect(isToolMarkupFragment("closing </oldString> now")).toBe(false))
})

describe("reasoningTailRepeats", () => {
  test("'hmm: ' repetition hits", () => expect(reasoningTailRepeats("hmm: ".repeat(400))).toBe(true))
  test("ordinary prose does not", () =>
    expect(reasoningTailRepeats("The file has three callers. I will read the first one, then update the test.".repeat(6))).toBe(false))
  test("code-like tail does not", () =>
    expect(reasoningTailRepeats("const x = 1\nconst y = 2\nreturn x + y\n".repeat(60))).toBe(false))
})

describe("degenerateStep", () => {
  test("fragment text, no tool call, stop", () =>
    expect(degenerateStep({ ...base, parts: [text("</oldString>"), reason("some reasoning")] })?.kind).toBe("fragment"))
  test("empty text with a normal reasoning stop is not degenerate", () =>
    expect(degenerateStep({ ...base, parts: [reason("I must stop immediately. No summary.")] })).toBeUndefined())
  test("empty text whose only payload is a markup tag is degenerate", () =>
    expect(degenerateStep({ ...base, parts: [reason("</table>")] })?.kind).toBe("fragment"))
  test("repeated reasoning tail with a short ending", () =>
    expect(degenerateStep({ ...base, parts: [text("Ok"), reason("hmm: ".repeat(500))] })?.kind).toBe("repetition"))
  test("normal short ending is not degenerate", () =>
    expect(degenerateStep({ ...base, parts: [text("Done."), reason("finished the change")] })).toBeUndefined())
  test("summary ending is not degenerate", () =>
    expect(degenerateStep({ ...base, parts: [text("I updated the config and ran the tests.")] })).toBeUndefined())
  test("question ending is not degenerate", () =>
    expect(degenerateStep({ ...base, parts: [text("Which file should I change?")] })).toBeUndefined())
  test("tool call present is not degenerate", () =>
    expect(degenerateStep({ ...base, finish: "tool-calls", parts: [text("</oldString>"), call("read")] })).toBeUndefined())
  test("error is not degenerate", () =>
    expect(degenerateStep({ ...base, error: new Error("aborted"), parts: [text("</oldString>")] })).toBeUndefined())
  test("finish length is not degenerate", () =>
    expect(degenerateStep({ ...base, finish: "length", parts: [text("</oldString>")] })).toBeUndefined())
})


describe("createRepetitionMonitor", () => {
  test("cuts a repeated reasoning stream", () => {
    const monitor = createRepetitionMonitor()
    expect(monitor.append("hmm: ".repeat(200))).toBe(true)
  })
  test("cuts the same stream at three-character delta boundaries", () => {
    const monitor = createRepetitionMonitor()
    const stream = "hmm: ".repeat(200)
    let fired = false
    for (let i = 0; i < stream.length && !fired; i += 3) fired = monitor.append(stream.slice(i, i + 3))
    expect(fired).toBe(true)
  })
  test("does not cut ordinary prose", () => {
    const monitor = createRepetitionMonitor()
    expect(
      monitor.append(
        ("The file has three callers. I will read the first one, then update the test. " +
          "There is no shortcut here; each branch needs its own check. ").repeat(6),
      ),
    ).toBe(false)
  })
  test("does not cut a short marker", () => {
    const monitor = createRepetitionMonitor()
    expect(monitor.append("</table>")).toBe(false)
  })
})

describe("degenerateStep repetition cut marker", () => {
  test("a repetition-cut marker is a repetition stop", () =>
    expect(degenerateStep({ ...base, parts: [{ type: "text", text: "", metadata: { repetitionCut: true } }] })?.kind).toBe(
      "repetition",
    ))
})
