/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

// Per-agent-type contract for what happens when a system agent's turn ends
// with no usable output (reasoning-only / empty stop). A transient invalid
// output must RETRY with a role-specific nudge instead of falling through to
// the generic user-facing reactivation, which would re-activate the writer
// as if a human were attached.
export type InvalidOutputPolicy = "primary" | "supervisor" | "checkpoint"

export const SYSTEM_INVALID_OUTPUT_POLICIES: Readonly<Record<string, InvalidOutputPolicy>> = {
  "checkpoint-writer": "checkpoint",
  dream: "supervisor",
  distill: "supervisor",
}

export function resolveInvalidOutputPolicy(input: {
  agentName: string
  agentID?: string
}): InvalidOutputPolicy {
  const system = SYSTEM_INVALID_OUTPUT_POLICIES[input.agentName]
  if (system) return system
  if (!input.agentID || input.agentID === "main") return "primary"
  return "supervisor"
}

/** Decide how a permission `ask` from the current turn should be routed:
 *  - system agent -> non-interactive (auto-deny, no human to answer)
 *  - orchestrator peer (background + mode:peer + has a parent) -> forward the ask
 *    for approval (interactive, with the parent session as approval route)
 *  - other background (e.g. harness subagents) -> non-interactive (auto-deny)
 *  - normal foreground -> interactive
 *  Pure function so the gate is unit-testable without a full prompt turn.
 */
export function decideAskRouting(input: {
  askSupervisor?: { agent: string; background: boolean; mode: string; parentSupervisorID?: string }
  sessionParentID?: string
  agentName: string
  // When false, orchestrator-peer forwarding is disabled (feature flag off) and
  // a peer falls back to the background auto-deny path.
  orchestratorEnabled?: boolean
}): { interactive: boolean; forward?: { parentSessionID: string } } {
  const isSystemAgent = input.askSupervisor
    ? SYSTEM_SPAWNED_AGENT_TYPES.has(input.askSupervisor.agent)
    : SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentName)
  if (isSystemAgent) return { interactive: false }
  const isOrchestratorPeer =
    input.orchestratorEnabled !== false &&
    !!input.askSupervisor?.background &&
    input.askSupervisor?.mode === "peer" &&
    !!(input.askSupervisor?.parentSupervisorID || input.sessionParentID)
  if (isOrchestratorPeer && input.sessionParentID) {
    return { interactive: true, forward: { parentSessionID: input.sessionParentID } }
  }
  return { interactive: !input.askSupervisor?.background }
}
