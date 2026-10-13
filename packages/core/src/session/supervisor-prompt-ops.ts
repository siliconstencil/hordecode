import type { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * Prompt-service ops surface the supervisor tool relies on at the session
 * boundary. Lived originally in the core supervisor tool twin
 * (packages/core/src/tool/supervisor.ts); moved here when that dead twin was
 * deleted because three core session files (checkpoint.ts, prompt.ts,
 * prune.ts) and the live opencode supervisor tool all import it, and core must
 * not depend on opencode.
 */
export interface SupervisorPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<any>
  prompt(input: any): Effect.Effect<any>
}
