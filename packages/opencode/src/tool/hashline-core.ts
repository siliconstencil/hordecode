// Hashline is an opt-in edit mode. A file is read as a header line `[path#tag]`
// followed by numbered lines (`n:content`). The tag is a short hash of the
// normalized file text, so an edit can name the exact revision it was planned
// against: the model edits by 1-based line numbers plus the tag, and a stale tag
// (the file changed since the read) is rejected instead of applied blindly.
// Behavior follows omp crates/pi-edit/src/store.rs:79-94 (whole-file tag over
// text with trailing whitespace trimmed per line) and
// crates/pi-edit/src/modes/hashline/mismatch.rs:80-146 (error kinds). No code is
// copied. This module is pure: it does no file IO and wires into no tool.
import { createHash } from "node:crypto"

const BOM = "﻿"
const LINE_BREAK = /\r\n|\r|\n/

export type HashlineOp =
  | { op: "replace"; start: number; end?: number; lines: string[] }
  | { op: "insert_before"; start: number; lines: string[] }
  | { op: "insert_after"; start: number; lines: string[] }
  | { op: "delete"; start: number; end?: number }

export type HashlineErrorKind = "stale_tag" | "out_of_range" | "overlap" | "empty_ops" | "bad_op"

export class HashlineError extends Error {
  readonly kind: HashlineErrorKind

  constructor(kind: HashlineErrorKind, message: string) {
    super(message)
    this.name = "HashlineError"
    this.kind = kind
  }
}

// Whole-file tag: BOM stripped, CRLF and lone CR become LF, trailing spaces and
// tabs trimmed per line, then the first 8 hex chars of SHA-1.
export function fileTag(text: string): string {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const normalized = body
    .split(LINE_BREAK)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
  return createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8)
}

// Splits text into lines without their terminators. eol is "\r\n" only when the
// text contains "\r\n"; otherwise "\n". A lone CR counts as a line break, the same
// as fileTag treats it. Empty text has no lines and no final newline.
export function splitLines(text: string): { lines: string[]; eol: "\n" | "\r\n"; finalNewline: boolean } {
  if (text === "") return { lines: [], eol: "\n", finalNewline: false }
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const finalNewline = text.endsWith("\n") || text.endsWith("\r")
  const parts = text.split(LINE_BREAK)
  return { lines: finalNewline ? parts.slice(0, -1) : parts, eol, finalNewline }
}

// Renders the read view: header `[path#tag]`, then `n:line` rows for the window
// starting at offset (1-based, default 1) with at most limit rows (default all,
// minimum 1). When lines remain after the window, a footer names the next offset.
// A leading BOM is not shown as part of line 1.
export function render(path: string, text: string, opts?: { offset?: number; limit?: number }): string {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const { lines } = splitLines(body)
  const start = Math.max(1, Math.floor(opts?.offset ?? 1)) - 1
  const limit = Math.max(1, Math.floor(opts?.limit ?? lines.length))
  const end = Math.min(lines.length, start + limit)
  const rows = lines.slice(start, end).map((line, i) => `${start + i + 1}:${line}`)
  const remaining = lines.length - end
  const footer = remaining > 0 ? [`... (${remaining} more lines, use offset=${end + 1})`] : []
  return [`[${path}#${fileTag(text)}]`, ...rows, ...footer].join("\n")
}

// Line numbers are 1-based and inclusive; end defaults to start. An insert names
// a gap: insert_before N sits before line N, insert_after N sits after line N.
// insert_after 0 inserts at the top of the file and is the only start 0 allowed.
// Model-supplied lines containing "\n", "\r" or "\r\n" are split into several
// lines, so one element can stand for a multi-line block. A tag mismatch raises
// stale_tag; the tag is compared trimmed and case-insensitively.
export function applyOps(text: string, tag: string, ops: HashlineOp[]): string {
  const current = fileTag(text)
  if (tag.trim().toLowerCase() !== current) {
    throw new HashlineError(
      "stale_tag",
      `File changed since it was read (tag ${tag} != ${current}). Re-read it with hashline_read and retry.`,
    )
  }
  if (ops.length === 0) throw new HashlineError("empty_ops", "No edit operations were given.")

  const bom = text.startsWith(BOM) ? BOM : ""
  const { lines, eol, finalNewline } = splitLines(bom ? text.slice(BOM.length) : text)
  const count = lines.length

  // Each op becomes an edit: a line range [lo, hi] for replace/delete, or a gap
  // index for inserts (gap g sits between line g and line g+1).
  const edits = ops.map((op, i) => {
    const label = `ops[${i}]`
    if (!op || typeof op !== "object") throw new HashlineError("bad_op", `${label} is not an object.`)
    if (!["replace", "insert_before", "insert_after", "delete"].includes(op.op)) {
      throw new HashlineError("bad_op", `${label} has unknown op "${String(op.op)}".`)
    }
    if (!Number.isInteger(op.start)) throw new HashlineError("bad_op", `${label} start must be an integer.`)

    if (op.op === "insert_before" || op.op === "insert_after") {
      if ("end" in op && op.end !== undefined) {
        throw new HashlineError("bad_op", `${label} ${op.op} takes no end.`)
      }
      if (!Array.isArray(op.lines) || op.lines.length === 0) {
        throw new HashlineError("bad_op", `${label} ${op.op} requires a non-empty lines array.`)
      }
      const minStart = op.op === "insert_after" ? 0 : 1
      if (op.start < minStart || op.start > count) {
        throw new HashlineError(
          "out_of_range",
          `${label} ${op.op} at line ${op.start} is outside 1..${count}${minStart === 0 ? " (or 0 for insert_after)" : ""}.`,
        )
      }
      const gap = op.op === "insert_before" ? op.start - 1 : op.start
      return { kind: "insert" as const, gap, index: i, lines: op.lines.flatMap(splitElement), label, op: op.op }
    }

    if (op.op === "replace" && !Array.isArray(op.lines)) {
      throw new HashlineError("bad_op", `${label} replace requires a lines array (empty array deletes).`)
    }
    const end = op.end ?? op.start
    if (!Number.isInteger(end)) throw new HashlineError("bad_op", `${label} end must be an integer.`)
    if (op.start > end) throw new HashlineError("bad_op", `${label} start ${op.start} is greater than end ${end}.`)
    if (op.start < 1 || end > count) {
      throw new HashlineError("out_of_range", `${label} ${op.op} range ${op.start}..${end} is outside 1..${count}.`)
    }
    const replacement = op.op === "replace" ? op.lines.flatMap(splitElement) : []
    return { kind: "range" as const, lo: op.start, hi: end, index: i, lines: replacement, label, op: op.op }
  })

  // Overlap: two ranges that share a line, or an insert gap strictly inside a
  // range (a <= gap < b, meaning between two lines of that range).
  edits.forEach((a, i) => {
    edits.forEach((b, j) => {
      if (j <= i) return
      if (a.kind === "range" && b.kind === "range" && a.lo <= b.hi && b.lo <= a.hi) {
        throw new HashlineError("overlap", `${a.label} (${a.op} ${a.lo}..${a.hi}) overlaps ${b.label} (${b.op} ${b.lo}..${b.hi}).`)
      }
      const [range, insert] = a.kind === "range" && b.kind === "insert" ? [a, b] : b.kind === "range" && a.kind === "insert" ? [b, a] : [undefined, undefined]
      if (range && insert && range.lo <= insert.gap && insert.gap < range.hi) {
        throw new HashlineError("overlap", `${insert.label} (${insert.op} at gap ${insert.gap}) falls inside ${range.label} (${range.op} ${range.lo}..${range.hi}).`)
      }
    })
  })

  // Apply bottom-up so line numbers above the edit stay valid. Keys: a range
  // starting at line s sorts as 2s, an insert at gap g as 2g+1 (it lies between
  // lines g and g+1). Descending key, then descending index: the later-given op
  // at the same point is applied first, so the earlier-given op lands above it.
  const ordered = edits.toSorted((a, b) => {
    const keyA = a.kind === "range" ? 2 * a.lo : 2 * a.gap + 1
    const keyB = b.kind === "range" ? 2 * b.lo : 2 * b.gap + 1
    return keyB - keyA || b.index - a.index
  })
  const out = ordered.reduce((acc, edit) => {
    if (edit.kind === "range") return [...acc.slice(0, edit.lo - 1), ...edit.lines, ...acc.slice(edit.hi)]
    return [...acc.slice(0, edit.gap), ...edit.lines, ...acc.slice(edit.gap)]
  }, lines)

  if (out.length === 0) return bom
  return bom + out.join(eol) + (finalNewline ? eol : "")
}

function splitElement(line: string): string[] {
  return line.split(LINE_BREAK)
}
