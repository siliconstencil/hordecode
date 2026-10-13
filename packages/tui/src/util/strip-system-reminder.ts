export const SYSTEM_REMINDER_RE = /<[^>]*system-reminder[^>]*>[\s\S]*?<\/[^>]*system-reminder\s*>/gi

export function stripSystemReminderBlocks(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, "").trim()
}
