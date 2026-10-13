/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

// Per-agent-type contract for invalid-output continuation. Mirrored from the
// canonical @opencode-ai/agent/config (twin registry parity.
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

// Routing for context.ask(): determines whether the current tool execution
// should be interactive (human-attached), forwarded (orchestrator peer), or
// inherit parent grants (background subagent with a parent session).
//
// Pure function so the gate is unit-testable without a full prompt turn.
export function decideAskRouting(input: {
  askSupervisor?: { agent: string; background: boolean; mode: string; parentSupervisorID?: string }
  sessionParentID?: string
  agentName: string
  // When false, orchestrator-peer forwarding is disabled and a peer falls back
  // to the background auto-deny path.
  orchestratorEnabled?: boolean
}): { interactive: boolean; forward?: { parentSessionID: string }; inherit?: { parentSessionID: string } } {
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
  // Ordinary background subagent that has a parent session: don't fail closed
  // outright -- let it inherit the permissions the parent already holds a grant
  // for. Still non-interactive (no human attached); the ask consults the parent
  // snapshot and auto-allows only genuinely-granted paths, else fails closed.
  if (input.askSupervisor?.background && input.sessionParentID) {
    return { interactive: false, inherit: { parentSessionID: input.sessionParentID } }
  }
  return { interactive: !input.askSupervisor?.background }
}
