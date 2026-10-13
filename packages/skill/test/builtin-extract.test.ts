import { describe, expect, test } from "bun:test"
import {
  builtinSkillRoot,
  matchDocumentSkills,
  OFFICIAL_SKILL_NAMES,
} from "../src/builtin/extract"

describe("OFFICIAL_SKILL_NAMES", () => {
  test("contains exactly the five official document skills", () => {
    expect([...OFFICIAL_SKILL_NAMES].sort()).toEqual([
      "docx-official",
      "html-to-video-pipeline",
      "pdf-official",
      "pptx-official",
      "xlsx-official",
    ])
  })
})

describe("builtinSkillRoot", () => {
  test("returns a path under data/builtin_skills with a version segment", () => {
    const root = builtinSkillRoot()
    expect(root).toContain("builtin_skills")
    expect(root).toMatch(/\/skills$/)
  })
})

describe("matchDocumentSkills", () => {
  test("returns empty array for no candidates", () => {
    expect(matchDocumentSkills([])).toEqual([])
  })

  test("matches pdf by mime", () => {
    expect(matchDocumentSkills([{ mime: "application/pdf" }])).toEqual(["pdf-official"])
  })

  test("matches pdf by filename", () => {
    expect(matchDocumentSkills([{ filename: "report.PDF" }])).toEqual(["pdf-official"])
  })

  test("matches docx by mime", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ]),
    ).toEqual(["docx-official"])
  })

  test("matches dotx template and legacy msword by mime", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.template" },
        { mime: "application/msword" },
      ]),
    ).toEqual(["docx-official"])
  })

  test("matches docx and dotx by filename", () => {
    expect(matchDocumentSkills([{ filename: "notes.docx" }, { filename: "plan.dotx" }])).toEqual([
      "docx-official",
    ])
  })

  test("does not match doc by filename (docx/dotx only)", () => {
    expect(matchDocumentSkills([{ filename: "legacy.doc" }])).toEqual([])
  })

  test("matches xlsx by mime", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ]),
    ).toEqual(["xlsx-official"])
  })

  test("matches xlsm, xltx, legacy xls and macro-enabled xls by mime", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.template" },
        { mime: "application/vnd.ms-excel" },
        { mime: "application/vnd.ms-excel.sheet.macroenabled.12" },
      ]),
    ).toEqual(["xlsx-official"])
  })

  test("matches csv and tsv by mime", () => {
    expect(
      matchDocumentSkills([{ mime: "text/csv" }, { mime: "text/tab-separated-values" }]),
    ).toEqual(["xlsx-official"])
  })

  test("matches xlsx, xlsm, xltx, csv, tsv by filename", () => {
    expect(
      matchDocumentSkills([
        { filename: "data.xlsx" },
        { filename: "macro.xlsm" },
        { filename: "template.xltx" },
        { filename: "data.csv" },
        { filename: "data.tsv" },
      ]),
    ).toEqual(["xlsx-official"])
  })

  test("does not match xls by filename (xlsx family only)", () => {
    expect(matchDocumentSkills([{ filename: "legacy.xls" }])).toEqual([])
  })

  test("matches pptx by mime", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        { mime: "application/vnd.ms-powerpoint" },
      ]),
    ).toEqual(["pptx-official"])
  })

  test("matches pptx by filename", () => {
    expect(matchDocumentSkills([{ filename: "deck.PPTX" }])).toEqual(["pptx-official"])
  })

  test("does not match ppt by filename (pptx only)", () => {
    expect(matchDocumentSkills([{ filename: "legacy.ppt" }])).toEqual([])
  })

  test("returns multiple skills in trigger-table order when candidates span families", () => {
    expect(
      matchDocumentSkills([
        { filename: "deck.pptx" },
        { mime: "application/pdf" },
        { filename: "data.csv" },
      ]),
    ).toEqual(["pdf-official", "xlsx-official", "pptx-official"])
  })

  test("deduplicates a single skill hit across multiple candidates", () => {
    expect(
      matchDocumentSkills([
        { mime: "application/pdf" },
        { filename: "a.pdf" },
        { filename: "b.pdf" },
      ]),
    ).toEqual(["pdf-official"])
  })

  test("returns no skills for unrelated mime and filename", () => {
    expect(
      matchDocumentSkills([{ mime: "text/plain" }, { filename: "main.ts" }]),
    ).toEqual([])
  })

  test("candidate with neither mime nor filename contributes nothing", () => {
    expect(matchDocumentSkills([{}])).toEqual([])
  })

  test("candidate mime wins over a non-matching filename on the same entry", () => {
    expect(
      matchDocumentSkills([{ mime: "application/pdf", filename: "notes.txt" }]),
    ).toEqual(["pdf-official"])
  })
})
