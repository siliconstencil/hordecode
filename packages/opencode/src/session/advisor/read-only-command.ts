// Hordecode read-only shell classifier. FORK_ONLY (advisor no_progress support).
// The advisor counts a read-only call as no progress; a shell command is read-only
// only when every segment of it is on the fixed whitelist below. The list is a
// safety list, not a completeness list: a command nobody reviewed stays progress.
const READ_ONLY = new Set(["rg", "grep", "ls", "wc", "head", "tail", "cat"])
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status"])

const writes = (command: string) => command.includes(">") || command.includes("<")
// Command substitution can run anything, and `-i` edits in place.
const substitutes = (command: string) => command.includes("$(") || command.includes("\u0060")
const inPlace = (command: string) => /(?:^|\s)(?:-i|--in-place)(?:\s|$)/.test(command)
const segments = (command: string) => command.split(/\|\||&&|[;|\n]/)

function segment(command: string) {
  const words = command.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
  const word = words.shift()
  if (word === undefined) return false
  const name = word.split("/").pop() ?? word
  if (name === "sed") return words.includes("-n")
  if (name === "git") return words.length > 0 && READ_ONLY_GIT.has(words[0])
  if (name === "sqlite3") return words.includes("-readonly")
  return READ_ONLY.has(name)
}

export function isReadOnlyCommand(command: string) {
  if (command.trim() === "") return false
  if (writes(command) || substitutes(command) || inPlace(command)) return false
  return segments(command).every(segment)
}
