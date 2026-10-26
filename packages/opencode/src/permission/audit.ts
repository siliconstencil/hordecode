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

export function write(entry: Record<string, unknown>) {
  if (!enabled()) return
  try {
    const target = file()
    const text = JSON.stringify({ time: Date.now(), ...entry, prev: previous(target) })
    const line = text + "\n"
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const size = fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes()) rotate(target)
    fs.appendFileSync(target, line, { mode: 0o600 })
    last.set(target, hash(text))
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

// Walks the rotated files oldest first and checks every chained line's `prev`.
export function verify(target = file()): Verification {
  const files: string[] = []
  for (let i = KEEP; i >= 1; i--) if (fs.existsSync(`${target}.${i}`)) files.push(`${target}.${i}`)
  if (fs.existsSync(target)) files.push(target)

  let lines = 0
  let legacy = 0
  let anchor: string | undefined
  let chained = false
  let expected: string | undefined
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
    if (request.denyOnly) return inner(request)
    // The id is fixed here so a decision line and its reply line share one requestID.
    const input = { ...request, id: request.id ?? PermissionV1.ID.ascending() }
    return inner(input).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          write({
            kind: "decision",
            requestID: input.id,
            sessionID: input.sessionID,
            permission: input.permission,
            patterns: input.patterns.map(redact),
            tool: input.tool?.callID,
            outcome: outcome(exit),
          }),
        ),
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
