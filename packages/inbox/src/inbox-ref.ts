import type { Effect } from "effect"
import type { SessionID } from "@opencode-ai/core/session/schema"
import type { MessageV2 } from "@opencode-ai/core/session/message-v2"
import type { Interface as InboxInterface } from "./inbox"

export interface SessionPromptLoopRef {
  loop: (input: { sessionID: SessionID; agentID: string; notifyParentOnComplete?: boolean }) => Effect.Effect<MessageV2.WithParts>
  prompt: (input: unknown) => Effect.Effect<unknown>
}

export const sessionPromptRef: { current: SessionPromptLoopRef | undefined } = {
  current: undefined,
}

export interface DefaultModelRef {
  defaultModel: () => Effect.Effect<{ providerID: string; modelID: string }, unknown>
}

export const defaultModelRef: { current: DefaultModelRef | undefined } = {
  current: undefined,
}

export const inboxServiceRef: { current: InboxInterface | undefined } = {
  current: undefined,
}
