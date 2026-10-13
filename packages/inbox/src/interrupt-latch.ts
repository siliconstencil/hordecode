import type { SessionID } from "@opencode-ai/core/session/schema"

// Per-session "user-cancelled" mark. Set by SessionPrompt.cancel; cleared ONLY
// by SessionPrompt.prompt when input.source === "user". Consulted by Inbox.send
// and the cron scheduler to suppress wake sites while set; rows stay durable in
// the inbox table and drain on the next user-source turn.
const interrupted = new Set<SessionID>()

export const setInterrupted = (sessionID: SessionID): void => {
  interrupted.add(sessionID)
}

export const clearInterrupted = (sessionID: SessionID): void => {
  interrupted.delete(sessionID)
}

export const isInterrupted = (sessionID: SessionID): boolean => interrupted.has(sessionID)
