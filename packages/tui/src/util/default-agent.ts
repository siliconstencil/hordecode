// The agent the TUI starts on. An agent chosen in the session wins; otherwise the configured `default_agent` when it is one
// of the selectable agents; otherwise the first selectable agent.
export function pickAgent<T extends { name: string }>(input: {
  agents: readonly T[]
  selected?: string
  configured?: string
}): T | undefined {
  return (
    input.agents.find((agent) => agent.name === input.selected) ??
    input.agents.find((agent) => input.configured !== undefined && agent.name === input.configured) ??
    input.agents.at(0)
  )
}
