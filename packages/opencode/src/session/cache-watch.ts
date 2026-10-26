// Watches for a prompt cache that never hits: two consecutive turns of one session that carried more than 20K prompt
// tokens (input plus cache reads and writes) and read nothing from the cache.
export const MIN_PROMPT_TOKENS = 20_000

type Tokens = { input: number; cache: { read: number; write: number } }

const streaks = new Map<string, number>()

// Returns true exactly once per streak, on the second consecutive miss.
export function observe(sessionID: string, tokens: Tokens): boolean {
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  if (tokens.cache.read > 0) {
    streaks.delete(sessionID)
    return false
  }
  if (prompt <= MIN_PROMPT_TOKENS) return false
  const count = (streaks.get(sessionID) ?? 0) + 1
  streaks.set(sessionID, count)
  return count === 2
}

export function clear(sessionID: string) {
  streaks.delete(sessionID)
}
