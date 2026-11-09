// Hordecode: the checkpoint-writer runs in a child session, so its spend is not
// part of the parent session's cost row. The sidebar and Activity surfaces show
// it as part of what the session cost while `horde stats` keeps counting child
// rows once (r6 A3). The writer child's agent marker is set when its turn runs.
export type SpendSession = {
  agent?: string
  cost?: number
}

export function memoryWriterCost(sessions: ReadonlyArray<SpendSession>): number {
  let total = 0
  for (const session of sessions) {
    if (session.agent === "checkpoint-writer") total += session.cost ?? 0
  }
  return total
}
