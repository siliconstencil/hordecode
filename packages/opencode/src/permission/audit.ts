import { createHash } from "node:crypto"
import fs from "fs"
import path from "path"
import { Cause, Effect, Exit, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NonInteractiveDeniedError } from "."

// One JSON line per permission decision and per human reply, under the log directory,
// rotated by size. Opt-in; a failed write never affects the permission flow.
// Each line carries `prev`, the SHA-256 of the previous line, so `verify` can detect edits.
// `<log>.head` records the hash of the newest line and of the oldest retained file's first line,
// so `verify` also detects a truncated tail and a deleted oldest file. It lives next to the log:
// it is not an external anchor, so someone who rewrites both can still pass verification.
// Concurrency: two processes appending to the same file can interleave and break the chain;
// this is not handled here.

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3
const ZERO = "0".repeat(64)
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

// Hash of the last line written per target path, valid across rotation (the last line moves to `<target>.1`).
const last = new Map<string, string>()

const env = (name: string) => process.env[`HORDECODE_${name}`] ?? process.env[`OPENCODE_${name}`]

export const enabled = () => ["1", "true"].includes((env("PERMISSION_AUDIT") ?? "").toLowerCase())

export const file = () => path.join(Global.Path.log, "permission.jsonl")

const maxBytes = () => Number(env("PERMISSION_AUDIT_MAX_BYTES")) || MAX_BYTES

const SECRET = "(?:api.?key|secret|password|passwd|token|authorization|cookie|credential|private.?key)"

export function redact(text: string) {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, "$1***@")
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 ***")
    .replace(new RegExp(`(\\b[\\w-]*${SECRET}[\\w-]*)(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), "$1$2***")
}

function rotate(target: string) {
  for (let i = KEEP - 1; i >= 1; i--) {
    if (fs.existsSync(`${target}.${i}`)) fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`)
  }
  fs.renameSync(target, `${target}.1`)
}

function lastLine(target: string) {
  if (!fs.existsSync(target)) return undefined
  return fs
    .readFileSync(target, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1)
}

function firstLine(target: string) {
  if (!fs.existsSync(target)) return undefined
  return fs.readFileSync(target, "utf8").split("\n")[0] || undefined
}

// Hash of the last line before the next append: cached per process, else read from disk.
function previous(target: string) {
  const cached = last.get(target)
  if (cached !== undefined) return cached
  const line = lastLine(target) ?? lastLine(`${target}.1`)
  const value = line === undefined ? ZERO : hash(line)
  last.set(target, value)
  return value
}

// Test-only: forget the cached chain head, as a new process would.
export function __resetForTest() {
  last.clear()
}

type Head = { first: string; last: string }

const headFile = (target: string) => `${target}.head`

function readHead(target: string): Head | undefined {
  try {
    const head = JSON.parse(fs.readFileSync(headFile(target), "utf8"))
    if (typeof head?.first !== "string" || typeof head?.last !== "string") return undefined
    return { first: head.first, last: head.last }
  } catch {
    return undefined
  }
}

// Written through a temporary file so a crash never leaves a half-written head.
function writeHead(target: string, head: Head) {
  const tmp = `${headFile(target)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(head) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, headFile(target))
}

// Hash of the first line of the oldest retained file; `pending` is the line being appended when none exists.
function oldest(target: string, pending: string) {
  for (const file of [`${target}.${KEEP}`, `${target}.2`, `${target}.1`, target]) {
    const line = firstLine(file)
    if (line !== undefined) return hash(line)
  }
  return hash(pending)
}

export function write(entry: Record<string, unknown>) {
  if (!enabled()) return
  try {
    const target = file()
    const head = readHead(target)
    const text = JSON.stringify({ time: Date.now(), ...entry, prev: previous(target) })
    const line = text + "\n"
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const size = fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0
    const rotated = size > 0 && size + Buffer.byteLength(line) > maxBytes()
    if (rotated) rotate(target)
    fs.appendFileSync(target, line, { mode: 0o600 })
    last.set(target, hash(text))
    const first = rotated || !head ? oldest(target, text) : head.first
    writeHead(target, { first, last: hash(text) })
  } catch {}
}

export type Broken = { file: string; line: number; reason: string }

export type Verification = {
  ok: boolean
  files: string[]
  lines: number
  legacy: number
  // `file:line` of the first chained line, where the chain starts.
  anchor: string | undefined
  broken?: Broken
}

// Walks the rotated files oldest first and checks every chained line's `prev`, then checks the
// oldest file's first line and the newest line against the head record.
export function verify(target = file()): Verification {
  const files: string[] = []
  for (let i = KEEP; i >= 1; i--) if (fs.existsSync(`${target}.${i}`)) files.push(`${target}.${i}`)
  if (fs.existsSync(target)) files.push(target)

  let lines = 0
  let legacy = 0
  let anchor: string | undefined
  let chained = false
  let expected: string | undefined
  let firstText: string | undefined
  let lastText: string | undefined
  const fail = (file: string, line: number, reason: string): Verification => ({
    ok: false,
    files,
    lines,
    legacy,
    anchor,
    broken: { file, line, reason },
  })

  for (const current of files) {
    const rows = fs.readFileSync(current, "utf8").split("\n")
    if (rows.at(-1) === "") rows.pop()
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i]!
      const where = i + 1
      lines++
      firstText ??= text
      lastText = text
      let entry: unknown
      try {
        entry = JSON.parse(text)
      } catch {
        return fail(current, where, "invalid JSON")
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return fail(current, where, "line is not an object")
      if (!("prev" in entry)) {
        if (chained) return fail(current, where, "legacy line after a chained line")
        legacy++
        expected = hash(text)
        continue
      }
      const prev = (entry as { prev: unknown }).prev
      if (!chained) {
        // Anchor: its predecessor may have been rotated out, so only a zero prev is meaningful.
        chained = true
        anchor = `${current}:${where}`
        if (prev === ZERO && lines > 1) return fail(current, where, "zero prev after earlier lines")
        expected = hash(text)
        continue
      }
      if (prev !== expected) return fail(current, where, `prev mismatch: expected ${expected}, found ${String(prev)}`)
      expected = hash(text)
    }
  }

  const newest = files.at(-1) ?? target
  if (!fs.existsSync(headFile(target))) {
    // Logs written before the head record existed have no anchor yet; only chained lines need one.
    if (anchor === undefined) return { ok: true, files, lines, legacy, anchor }
    return fail(newest, lines + 1, "head record missing: truncation of the tail or of the oldest file cannot be checked")
  }
  const head = readHead(target)
  if (!head) return fail(headFile(target), 1, "head record unreadable")
  if (lastText === undefined || hash(lastText) !== head.last)
    return fail(newest, lines, `tail mismatch: head expects last line ${head.last}, found ${lastText === undefined ? "none" : hash(lastText)}`)
  const oldestFile = files[0] ?? target
  if (firstText === undefined || hash(firstText) !== head.first)
    return fail(oldestFile, 1, `oldest file mismatch: expected first line ${head.first}, found ${firstText === undefined ? "none" : hash(firstText)}`)
  return { ok: true, files, lines, legacy, anchor }
}

function outcome(exit: Exit.Exit<void, PermissionV1.Error>) {
  if (Exit.isSuccess(exit)) return "allow"
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) return Cause.hasInterrupts(exit.cause) ? "interrupted" : "defect"
  if (error.value instanceof NonInteractiveDeniedError) return "deny_non_interactive"
  if (error.value._tag === "PermissionDeniedError") return "deny"
  if (error.value._tag === "PermissionCorrectedError") return "reject_with_feedback"
  if (error.value._tag === "PermissionTimeoutError") return "timeout"
  return "reject"
}

export const ask =
  <R>(inner: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error, R>) =>
  (request: PermissionV1.AskInput) => {
    // The id is fixed here so a decision line and its reply line share one requestID.
    const input = { ...request, id: request.id ?? PermissionV1.ID.ascending() }
    return inner(input).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          // A deny-only probe that no deny rule answers decides nothing, so it is not logged.
          if (request.denyOnly && Exit.isSuccess(exit)) return
          write({
            kind: "decision",
            requestID: input.id,
            sessionID: input.sessionID,
            permission: input.permission,
            patterns: input.patterns.map(redact),
            tool: input.tool?.callID,
            outcome: outcome(exit),
          })
        }),
      ),
    )
  }

export const reply =
  <E, R>(inner: (input: PermissionV1.ReplyInput) => Effect.Effect<void, E, R>) =>
  (input: PermissionV1.ReplyInput) =>
    inner(input).pipe(
      Effect.tap(() =>
        Effect.sync(() => write({ kind: "reply", requestID: input.requestID, reply: input.reply })),
      ),
    )

export * as PermissionAudit from "./audit"
