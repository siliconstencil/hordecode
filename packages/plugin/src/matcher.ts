import { BUILT_IN_AGENTS, type SupervisorMatcher } from "@opencode-ai/plugin"

const isBuiltIn = (agentType: string): boolean => (BUILT_IN_AGENTS as readonly string[]).includes(agentType)

export function matchesSupervisor(
  matcher: SupervisorMatcher | undefined,
  input: { mode: "subagent" | "peer"; agentType: string },
): boolean {
  if (!matcher) return !isBuiltIn(input.agentType)
  if (matcher.mode && matcher.mode !== input.mode) return false
  const at = matcher.agentType
  if (at === undefined) return !isBuiltIn(input.agentType)
  if (typeof at === "string") {
    if (isBuiltIn(input.agentType)) return false
    return new RegExp(at).test(input.agentType)
  }
  if (Array.isArray(at)) return at.includes(input.agentType)
  const rule = at as { excludeOnly?: readonly string[]; exclude?: readonly string[]; include?: readonly string[] }
  if (rule.excludeOnly) return !rule.excludeOnly.includes(input.agentType)
  if (rule.exclude?.includes(input.agentType)) return false
  if (rule.include) return rule.include.includes(input.agentType)
  return !isBuiltIn(input.agentType)
}
