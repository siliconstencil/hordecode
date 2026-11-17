import type { ModelMessage } from "ai"
import { Flag } from "@opencode-ai/core/flag/flag"

// FORK_ONLY: the single prompt image cap for both transforms. The reference
// systems (opencode 1.19.3, MiMo 0.1.11) have no comparable cap; the fork keeps
// its existing texts and its drop-oldest-then-size precedence so the output
// contract does not change. A user image can arrive as an AI SDK ImagePart or
// as a FilePart with an image media type, so both shapes count.
type MediaPart = { type: string; mediaType?: unknown; image?: unknown; data?: unknown }

function isImagePart(part: unknown): part is MediaPart {
  const value = part as MediaPart | undefined
  if (value?.type === "image") return true
  if (value?.type !== "file") return false
  return typeof value.mediaType === "string" && value.mediaType.startsWith("image/")
}

function mediaValue(part: MediaPart): string | Uint8Array | undefined {
  const value = part.type === "image" ? part.image : part.data
  return typeof value === "string" || value instanceof Uint8Array ? value : undefined
}

function imageByteSize(value: string | Uint8Array | undefined): number | undefined {
  if (value === undefined) return undefined
  if (value instanceof Uint8Array) return value.byteLength
  if (!value.startsWith("data:")) return undefined
  const base64 = value.slice(value.indexOf(",") + 1)
  if (!base64) return 0
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function limitImages(msgs: ModelMessage[]): ModelMessage[] {
  const maxImages = Flag.HORDECODE_MAX_PROMPT_IMAGES
  const maxSize = Flag.HORDECODE_MAX_PROMPT_IMAGE_SIZE
  if (maxImages === undefined && maxSize === undefined) return msgs
  const total = msgs.reduce(
    (sum, msg) =>
      msg.role === "user" && Array.isArray(msg.content)
        ? sum + msg.content.filter((part) => isImagePart(part)).length
        : sum,
    0,
  )
  // Drop the oldest excess images so the most recent ones reach the model.
  let toDrop = maxImages === undefined ? 0 : Math.max(0, total - maxImages)
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg
    const content = msg.content.map((part) => {
      if (!isImagePart(part)) return part
      if (toDrop > 0) {
        toDrop--
        return {
          type: "text" as const,
          text: `[Image omitted: exceeds the configured limit of ${maxImages} prompt image(s).]`,
        }
      }
      if (maxSize !== undefined) {
        const size = imageByteSize(mediaValue(part))
        if (size !== undefined && size > maxSize)
          return {
            type: "text" as const,
            text: `[Image omitted: exceeds the configured ${maxSize}-byte prompt image size limit.]`,
          }
      }
      return part
    })
    return { ...msg, content } as ModelMessage
  })
}
