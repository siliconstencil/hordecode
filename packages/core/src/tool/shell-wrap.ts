import { Cause, Effect, Schema } from "effect"
import { ToolFailure, type ToolCall, type ToolOutput } from "@opencode-ai/llm"
import type { Context as ToolContext } from "./tool"

export const shellInputSchema = Schema.Struct({
  script: Schema.String,
})

type ShellInput = typeof shellInputSchema.Type
type SettleFn = (call: ToolCall, context: ToolContext) => Effect.Effect<ToolOutput, ToolFailure>

export interface ToolShellConfig {
  readonly description: string
  readonly parse: (script: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
  readonly recover?: (rawArgs: unknown) => Record<string, unknown> | undefined
}

export function shellWrapSettle(
  toolId: string,
  toolShell: ToolShellConfig,
  normalSettle: SettleFn,
): SettleFn {
  return (call, ctx) =>
    Effect.gen(function* () {
      // Decode shell input -- if decode fails, try recover with raw input
      const decodedExit = yield* Effect.exit(Schema.decodeUnknownEffect(shellInputSchema)(call.input))
      if (decodedExit._tag === "Failure") {
        const recovered = toolShell.recover?.(call.input as unknown)
        if (recovered !== undefined) {
          const exit = yield* Effect.exit(normalSettle({ ...call, input: recovered }, ctx))
          if (exit._tag === "Failure") {
            return toolOutput(
              formatFailedCommandNoVerb(jsonTeachingBody(toolId, describeFailure(exit.cause))),
              undefined,
              0,
              0,
            )
          }
          return {
            ...exit.value,
            content: [{ type: "text" as const, text: exit.value.content?.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "" }],
            // recover success is a single routed command
            structured: exit.value.structured ?? {},
            metadata: { ...((exit.value as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}), commands: 1, success: 1 },
          } as unknown as ToolOutput
        }
        const o = (typeof call.input === "object" && call.input ? call.input : {}) as Record<string, unknown>
        const body = "script" in o ? shellTeachingBody(toolId) : jsonTeachingBody(toolId)
        return toolOutput(formatFailedCommandNoVerb(body), undefined, 0, 0)
      }
      const shellInput = decodedExit.value

      // Guard: no usable script
      if (typeof shellInput.script !== "string" || shellInput.script.trim() === "") {
        const recovered = toolShell.recover?.(call.input as unknown)
        if (recovered !== undefined) {
          const exit = yield* Effect.exit(normalSettle({ ...call, input: recovered }, ctx))
          if (exit._tag === "Failure") {
            return toolOutput(
              formatFailedCommandNoVerb(jsonTeachingBody(toolId, describeFailure(exit.cause))),
              undefined,
              0,
              0,
            )
          }
          return {
            ...exit.value,
            content: [{ type: "text" as const, text: exit.value.content?.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "" }],
            structured: exit.value.structured ?? {},
            metadata: { ...((exit.value as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}), commands: 1, success: 1 },
          } as unknown as ToolOutput
        }
        const o = (typeof call.input === "object" && call.input ? call.input : {}) as Record<string, unknown>
        const body = "script" in o ? shellTeachingBody(toolId) : jsonTeachingBody(toolId)
        return toolOutput(formatFailedCommandNoVerb(body), undefined, 0)
      }

      // Parse script with rescue for doubled JSON escapes
      let rescued = false
      let parsedList: ReadonlyArray<Record<string, unknown>>
      const firstParse = yield* Effect.exit(toolShell.parse(shellInput.script))
      if (firstParse._tag === "Failure") {
        const repaired = repairJsonEscapes(shellInput.script)
        if (repaired !== undefined) {
          const retry = yield* Effect.exit(toolShell.parse(repaired))
          if (retry._tag === "Success") {
            parsedList = retry.value
            rescued = true
          } else {
            const err = Cause.squash(retry.cause)
            return toolOutput(formatFailedCommandNoVerb(formatParseError(toolId, err)), undefined, 0)
          }
        } else {
          const err = Cause.squash(firstParse.cause)
          return toolOutput(formatFailedCommandNoVerb(formatParseError(toolId, err)), undefined, 0)
        }
      } else {
        parsedList = firstParse.value
      }
      if (parsedList.length === 0) {
        return toolOutput(formatFailedCommandNoVerb(`${toolId}: no commands found in script`), undefined, 0)
      }

      // Execute each parsed command through the normal settle
      const blocks: string[] = []
      if (rescued) blocks.push(formatNotice(rescueNoticeBody(toolId)))
      let lastStructured: unknown = undefined
      let success = 0

      for (let i = 0; i < parsedList.length; i++) {
        const parsed = parsedList[i]
        const op = operationLabel(parsed)
        const exit = yield* Effect.exit(normalSettle({ ...call, input: parsed }, ctx))
        if (exit._tag === "Failure") {
          blocks.push(formatFailedCommand(i + 1, op, describeFailure(exit.cause)))
          if (i + 1 < parsedList.length) {
            blocks.push(`<not-executed>commands #${i + 2}..#${parsedList.length}</not-executed>`)
          }
          return toolOutput(blocks.join("\n"), undefined, parsedList.length, success)
        }
        success++
        lastStructured = exit.value.structured
        const text = exit.value.content?.map((p) => (p.type === "text" ? p.text : "")).join("") ?? ""
        blocks.push(formatOkCommand(i + 1, op, text))
      }

      return toolOutput(blocks.join("\n"), lastStructured, parsedList.length, success)
    })
}

function toolOutput(text: string, structured: unknown, commands: number, success?: number): ToolOutput {
  return {
    content: [{ type: "text" as const, text }],
    structured: structured ?? {},
    metadata: { commands, success: success ?? commands },
  } as unknown as ToolOutput
}

function operationLabel(parsed: unknown): string {
  const op = (parsed as { operation?: unknown } | null | undefined)?.operation
  if (typeof op === "string") return op
  if (op && typeof op === "object" && typeof (op as { action?: unknown }).action === "string") {
    return (op as { action: string }).action
  }
  return "?"
}

function escapeAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) return squashed.message
  return String(squashed)
}

function formatOkCommand(index: number, operation: string, body: string): string {
  return `<command index="${index}" operation="${escapeAttr(operation)}">\n${body}\n</command>`
}

function formatFailedCommand(index: number, operation: string, body: string): string {
  return `<command index="${index}" operation="${escapeAttr(operation)}" failed="true">\n${body}\n</command>`
}

function formatFailedCommandNoVerb(body: string): string {
  return `<command failed="true">\n${body}\n</command>`
}

function formatNotice(body: string): string {
  return `<notice>\n${body}\n</notice>`
}

function repairJsonEscapes(script: string): string | undefined {
  if (!/\\[nt]/.test(script)) return undefined
  return script.replace(/\\n/g, "\n").replace(/\\t/g, "\t")
}

function rescueNoticeBody(toolId: string): string {
  return [
    `${toolId}: your script had no real line breaks -- literal \\n / \\t were read as newlines/tabs.`,
    `Emit REAL line breaks in the JSON string (JSON \\n), not a doubled backslash (\\\\n).`,
    `If you meant a LITERAL \\n / \\t inside a quoted string, it was rewritten too -- double-escape it (\\\\\\\\n) so it survives.`,
  ].join("\n")
}

function shellTeachingBody(toolId: string): string {
  return [
    `${toolId}: this tool takes a single \`script\` string (shell-style), not JSON fields.`,
    `Put the command in \`script\`, e.g.:  ${toolId} <verb> ...`,
    `See the tool description for the verb list and examples.`,
  ].join("\n")
}

function jsonTeachingBody(toolId: string, detail?: string): string {
  return [
    `${toolId}: could not run the call.`,
    `Pass the operation as JSON, e.g.:  {"operation":{"action":"<verb>", ...}}`,
    ...(detail ? [`detail: ${detail}`] : []),
  ].join("\n")
}

function formatParseError(toolId: string, err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind: string; line?: number; detail?: string }
    const line = e.line ?? "?"
    return `${toolId}: parse error at line ${line}\n  ${e.detail ?? e.kind}`
  }
  if (err instanceof Error) return `${toolId}: parse error\n  ${err.message}`
  return `${toolId}: parse error\n  ${String(err)}`
}
