import fs from "fs"
import path from "path"
import { Cause, Effect, Exit, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NonInteractiveDeniedError } from "."

// One JSON line per permission decision and per human reply, under the log directory,
// rotated by size. Opt-in; a failed write never affects the permission flow.

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

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

export function write(entry: Record<string, unknown>) {
  if (!enabled()) return
  try {
    const target = file()
    const line = JSON.stringify({ time: Date.now(), ...entry }) + "\n"
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const size = fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes()) rotate(target)
    fs.appendFileSync(target, line, { mode: 0o600 })
  } catch {}
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
