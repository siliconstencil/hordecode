import { describe, expect, test } from "bun:test"
import { applyOps, fileTag, HashlineError, render, splitLines, type HashlineOp } from "../../src/tool/hashline-core"

const kindOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof HashlineError ? err.kind : "other"
  }
  return "none"
}

describe("fileTag", () => {
  test("is stable across CRLF vs LF, trailing spaces and BOM", () => {
    const base = fileTag("alpha\nbeta\n")
    expect(fileTag("alpha\r\nbeta\r\n")).toBe(base)
    expect(fileTag("alpha  \t\nbeta \n")).toBe(base)
    expect(fileTag("﻿alpha\nbeta\n")).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{8}$/)
  })

  test("changes when content changes", () => {
    expect(fileTag("alpha\nbeta\n")).not.toBe(fileTag("alpha\ngamma\n"))
    expect(fileTag("alpha\nbeta")).not.toBe(fileTag("alpha\nbeta\n"))
  })
})

describe("splitLines", () => {
  test("detects eol and final newline", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual({ lines: ["a", "b"], eol: "\r\n", finalNewline: true })
    expect(splitLines("a\nb")).toEqual({ lines: ["a", "b"], eol: "\n", finalNewline: false })
  })

  test("empty text has no lines", () => {
    expect(splitLines("")).toEqual({ lines: [], eol: "\n", finalNewline: false })
  })
})

describe("render", () => {
  test("header, numbering and full window", () => {
    const text = "one\ntwo\nthree\n"
    expect(render("src/a.ts", text)).toBe(`[src/a.ts#${fileTag(text)}]\n1:one\n2:two\n3:three`)
  })

  test("offset and limit window with footer", () => {
    const text = "one\ntwo\nthree\nfour\nfive\n"
    const tag = fileTag(text)
    expect(render("f", text, { offset: 2, limit: 2 })).toBe(
      `[f#${tag}]\n2:two\n3:three\n... (2 more lines, use offset=4)`,
    )
    expect(render("f", text, { offset: 4 })).toBe(`[f#${tag}]\n4:four\n5:five`)
  })

  test("empty file renders header only", () => {
    expect(render("f", "")).toBe(`[f#${fileTag("")}]`)
  })
})

describe("applyOps", () => {
  const text = "one\ntwo\nthree\nfour\nfive\n"
  const tag = fileTag(text)

  test("replace single line", () => {
    expect(applyOps(text, tag, [{ op: "replace", start: 2, lines: ["TWO"] }])).toBe("one\nTWO\nthree\nfour\nfive\n")
  })

  test("replace range with more and fewer lines", () => {
    expect(applyOps(text, tag, [{ op: "replace", start: 2, end: 3, lines: ["a", "b", "c"] }])).toBe(
      "one\na\nb\nc\nfour\nfive\n",
    )
    expect(applyOps(text, tag, [{ op: "replace", start: 2, end: 4, lines: ["x"] }])).toBe("one\nx\nfive\n")
  })

  test("delete range and replace with empty lines", () => {
    expect(applyOps(text, tag, [{ op: "delete", start: 2, end: 4 }])).toBe("one\nfive\n")
    expect(applyOps(text, tag, [{ op: "replace", start: 1, end: 2, lines: [] }])).toBe("three\nfour\nfive\n")
  })

  test("insert_before line 1", () => {
    expect(applyOps(text, tag, [{ op: "insert_before", start: 1, lines: ["zero"] }])).toBe(
      "zero\none\ntwo\nthree\nfour\nfive\n",
    )
  })

  test("insert_after last line", () => {
    expect(applyOps(text, tag, [{ op: "insert_after", start: 5, lines: ["six"] }])).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix\n",
    )
  })

  test("insert_after 0 inserts at the top", () => {
    expect(applyOps(text, tag, [{ op: "insert_after", start: 0, lines: ["top"] }])).toBe(
      "top\none\ntwo\nthree\nfour\nfive\n",
    )
  })

  test("insert_after 0 works on an empty file", () => {
    expect(applyOps("", fileTag(""), [{ op: "insert_after", start: 0, lines: ["a", "b"] }])).toBe("a\nb")
  })

  test("multiple non-overlapping ops in arbitrary order match a hand edit", () => {
    const ops: HashlineOp[] = [
      { op: "insert_after", start: 4, lines: ["after-four"] },
      { op: "replace", start: 1, lines: ["ONE", "ONE2"] },
      { op: "delete", start: 3 },
      { op: "insert_before", start: 5, lines: ["before-five"] },
    ]
    expect(applyOps(text, tag, ops)).toBe("ONE\nONE2\ntwo\nfour\nafter-four\nbefore-five\nfive\n")
  })

  test("ties at the same point keep the given order", () => {
    const ops: HashlineOp[] = [
      { op: "insert_before", start: 2, lines: ["A"] },
      { op: "insert_after", start: 1, lines: ["B"] },
    ]
    expect(applyOps(text, tag, ops)).toBe("one\nA\nB\ntwo\nthree\nfour\nfive\n")
  })

  test("CRLF file keeps CRLF", () => {
    const crlf = "one\r\ntwo\r\nthree\r\n"
    expect(applyOps(crlf, fileTag(crlf), [{ op: "replace", start: 2, lines: ["2"] }])).toBe("one\r\n2\r\nthree\r\n")
  })

  test("file without final newline keeps none", () => {
    const bare = "one\ntwo"
    expect(applyOps(bare, fileTag(bare), [{ op: "insert_after", start: 2, lines: ["three"] }])).toBe(
      "one\ntwo\nthree",
    )
  })

  test("a model line containing a newline is split into several lines", () => {
    expect(applyOps(text, tag, [{ op: "replace", start: 1, lines: ["x\ny"] }])).toBe("x\ny\ntwo\nthree\nfour\nfive\n")
  })

  test("trailing spaces in the read view do not change the tag", () => {
    const spaced = "one  \ntwo\n"
    expect(applyOps(spaced, fileTag("one\ntwo\n"), [{ op: "replace", start: 2, lines: ["2"] }])).toBe(
      "one  \n2\n",
    )
  })

  test("stale tag raises stale_tag", () => {
    expect(kindOf(() => applyOps(text, "00000000", [{ op: "delete", start: 1 }]))).toBe("stale_tag")
    expect(kindOf(() => applyOps(text, tag.toUpperCase(), [{ op: "delete", start: 1 }]))).toBe("none")
  })

  test("overlapping ranges raise overlap", () => {
    expect(
      kindOf(() =>
        applyOps(text, tag, [
          { op: "replace", start: 1, end: 3, lines: ["x"] },
          { op: "delete", start: 3, end: 4 },
        ]),
      ),
    ).toBe("overlap")
  })

  test("insert strictly inside a replaced range raises overlap", () => {
    expect(
      kindOf(() =>
        applyOps(text, tag, [
          { op: "replace", start: 2, end: 4, lines: ["x"] },
          { op: "insert_after", start: 3, lines: ["y"] },
        ]),
      ),
    ).toBe("overlap")
  })

  test("insert at the boundary of a replaced range is allowed", () => {
    expect(
      applyOps(text, tag, [
        { op: "replace", start: 2, end: 3, lines: ["x"] },
        { op: "insert_before", start: 2, lines: ["pre"] },
      ]),
    ).toBe("one\npre\nx\nfour\nfive\n")
  })

  test("out of range raises out_of_range", () => {
    expect(kindOf(() => applyOps(text, tag, [{ op: "delete", start: 6 }]))).toBe("out_of_range")
    expect(kindOf(() => applyOps(text, tag, [{ op: "insert_before", start: 0, lines: ["x"] }]))).toBe("out_of_range")
    expect(kindOf(() => applyOps(text, tag, [{ op: "insert_after", start: 6, lines: ["x"] }]))).toBe("out_of_range")
    expect(kindOf(() => applyOps("", fileTag(""), [{ op: "insert_before", start: 1, lines: ["x"] }]))).toBe(
      "out_of_range",
    )
  })

  test("empty ops raise empty_ops", () => {
    expect(kindOf(() => applyOps(text, tag, []))).toBe("empty_ops")
  })

  test("malformed ops raise bad_op", () => {
    expect(kindOf(() => applyOps(text, tag, [{ op: "replace", start: 3, end: 2, lines: ["x"] }]))).toBe("bad_op")
    expect(kindOf(() => applyOps(text, tag, [{ op: "insert_after", start: 1, lines: [] }]))).toBe("bad_op")
    expect(kindOf(() => applyOps(text, tag, [{ op: "replace", start: 1.5, lines: ["x"] }]))).toBe("bad_op")
  })
})
