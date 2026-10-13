// Safe empty-result stub (never throws, matches the shape prompt.ts's own
// capture closure already falls back to on every other error path). Full
// implementation blocked on: llm.buildSystemArray(...) (LLM.Service method)
// and toolRegistry.tools(...) (ToolRegistry API) being available, which needs
// the same materialize()/settle() bridge treatment applied to
// session/prompt.ts's 4 call sites.
import { Effect } from "effect"
import type { Tool as AITool } from "ai"
import type { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import type { Agent } from "@opencode-ai/agent/agent"
import type { Provider } from "../provider/index"

export const buildLLMRequestPrefix = Effect.fn("Session.buildLLMRequestPrefix")(function* (_input: {
  sessionID: SessionID
  agent: Agent.Info
  model: Provider.Model
  msgs: MessageV2.WithParts[]
  additions: string[]
}) {
  return {
    system: [] as string[],
    tools: {} as Record<string, AITool>,
    inheritedMessages: [] as unknown[],
  }
})
