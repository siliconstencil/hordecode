import { describe, expect, test } from "bun:test"
import { formatRunTable, type RunRow } from "../../src/cli/cmd/stats"

const row: RunRow = {
  root: "ses_e511ad789f",
  start: "2026-11-03 22:11",
  title: "p3 steps",
  subs: 8,
  steps: 1446,
  capHits: 9,
  spanH: 20.2,
  modelH: 8.3,
  idleH: 15.4,
  idleGaps: 7,
  tools: 1201,
  toolErr: 19,
  inMtok: 45.6,
}

describe("stats --runs table", () => {
  test("the header names every scorecard column", () => {
    const [header] = formatRunTable([row]).split("\n")
    expect(header.trim().split(/\s+/)).toEqual([
      "root",
      "start_pst",
      "title",
      "subs",
      "steps",
      "cap_hits",
      "span_h",
      "model_h",
      "idle_h",
      "idle_gaps",
      "tools",
      "tool_err",
      "in_Mtok",
    ])
  })

  test("a row renders the scorecard values with one decimal for hours and tokens", () => {
    const [, line] = formatRunTable([row]).split("\n")
    expect(line.trim().split(/\s{2,}/)).toEqual([
      "ses_e511ad789f",
      "2026-11-03 22:11",
      "p3 steps",
      "8",
      "1446",
      "9",
      "20.2",
      "8.3",
      "15.4",
      "7",
      "1201",
      "19",
      "45.6",
    ])
  })

  test("zero hours keep one decimal", () => {
    const [, line] = formatRunTable([{ ...row, spanH: 0, modelH: 1, idleH: 0, inMtok: 0 }]).split("\n")
    expect(line.trim().split(/\s{2,}/).slice(6, 9)).toEqual(["0.0", "1.0", "0.0"])
    expect(line.trim().split(/\s{2,}/).at(-1)).toBe("0.0")
  })

  test("no rows still prints the header", () => {
    expect(formatRunTable([]).split("\n").length).toBe(1)
  })
})
