// Port note: TrajectoryMessage/TrajectoryPart types come from
// @opencode-ai/plugin, which has no fork equivalent yet (plugin type surface
// not ported). Return types are widened to `any`/loose shapes rather than
// blocking on that port; the runtime behavior below is a full, faithful
// port of the reference trajectory.ts.
import { MessageV2 } from "./message-v2"

function fileUrlSummary(url: string, mime: string, filename?: string) {
  if (!url.startsWith("data:")) return url
  return `[data-url:${mime}${filename ? `:${filename}` : ""}]`
}

function serializeFilePart(part: MessageV2.FilePart): MessageV2.FilePart {
  return { ...part, url: fileUrlSummary(part.url, part.mime, part.filename) }
}

function sanitizeToolState(state: MessageV2.ToolPart["state"]): MessageV2.ToolPart["state"] {
  if (state.status === "completed" && (state as any).attachments && (state as any).attachments.length > 0) {
    return { ...state, attachments: (state as any).attachments.map(serializeFilePart) } as any
  }
  return state
}

export function serializePart(part: MessageV2.Part): any {
  if (part.type === "file") return serializeFilePart(part)
  if (part.type === "tool") return { ...part, state: sanitizeToolState(part.state) }
  return part
}

/** Stringify an assistant error blob (NamedError, AbortedError, etc.) for plugin payloads. */
export function sessionErrorText(error: MessageV2.Assistant["error"]): string | undefined {
  if (!error) return undefined
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as any).message === "string") {
    return (error as any).message
  }
  return JSON.stringify(error)
}

/** Concatenate non-synthetic, non-ignored user text parts (the visible user query). */
export function userQueryText(parts: MessageV2.Part[]): string {
  return parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !(p as any).synthetic && !(p as any).ignored)
    .map((p) => p.text)
    .join("\n")
}

/** Last non-synthetic assistant text, or stringified structured output if present. */
export function assistantFinalText(message: MessageV2.Assistant, parts: MessageV2.Part[]): string | undefined {
  if ((message as any).structured !== undefined) return JSON.stringify((message as any).structured)
  return parts.findLast((p): p is MessageV2.TextPart => p.type === "text" && !(p as any).synthetic)?.text
}

/** Serialize a slice of session messages into the wire trajectory format. */
export function serializeTrajectoryMessages(msgs: MessageV2.WithParts[]): any[] {
  return msgs.map((msg) => ({
    ...msg.info,
    created: msg.info.time.created,
    parts: msg.parts.map(serializePart),
  }))
}

/** Replace the assistant entry in a message slice with freshly loaded parts. */
export function withAssistantParts(
  msgs: MessageV2.WithParts[],
  assistant: MessageV2.Assistant,
  parts: MessageV2.Part[],
): MessageV2.WithParts[] {
  const idx = msgs.findIndex((m) => m.info.id === assistant.id)
  if (idx === -1) return [...msgs, { info: assistant, parts } as MessageV2.WithParts]
  return msgs.map((m, i) => (i === idx ? ({ info: assistant, parts } as MessageV2.WithParts) : m))
}
