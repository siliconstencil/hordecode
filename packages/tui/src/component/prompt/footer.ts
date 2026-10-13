import { Locale } from "../../util/locale"

export const STATUS_MESSAGE_MAX = 48

export function clampStatusMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  const flat = message.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return Locale.truncate(flat, STATUS_MESSAGE_MAX)
}
