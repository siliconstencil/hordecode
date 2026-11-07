// Fork: the run scorecard line. One line that a run can show about itself:
// steps, tool calls, the unique (tool, input) ratio, failed calls and idle time
// (turn span minus model time). It is the same shape as `horde stats --runs`,
// scoped to one turn.
export type ScorePart = {
  tool?: string
  input?: unknown
  error?: boolean
}

export type ScoreMessage = {
  created: number
  completed?: number
  parts: ScorePart[]
}

export type RunScore = {
  steps: number
  calls: number
  unique: number
  errors: number
  idleMs: number
}

export function scoreRun(messages: ScoreMessage[]): RunScore {
  const calls = messages.flatMap((message) => message.parts).filter((part) => part.tool !== undefined)
  const signatures = new Set(calls.map((part) => `${part.tool}\u0000${JSON.stringify(part.input ?? {})}`))
  const timed = messages.filter((message) => message.completed !== undefined && message.completed > message.created)
  const span = timed.length === 0 ? 0 : Math.max(...timed.map((message) => message.completed!)) - Math.min(...timed.map((message) => message.created))
  const model = timed.reduce((sum, message) => sum + (message.completed! - message.created), 0)
  return {
    steps: messages.length,
    calls: calls.length,
    unique: calls.length === 0 ? 1 : Math.round((signatures.size / calls.length) * 100) / 100,
    errors: calls.filter((part) => part.error).length,
    idleMs: Math.max(0, span - model),
  }
}

export function formatRunScore(score: RunScore): string {
  const idle = (score.idleMs / 60_000).toFixed(1)
  return `score: steps ${score.steps} | calls ${score.calls} | unique ${score.unique.toFixed(2)} | errors ${score.errors} | idle ${idle}m`
}
