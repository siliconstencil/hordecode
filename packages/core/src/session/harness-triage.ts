/**
 * Harness triage: classify the user's request as routine or complex from cheap signals and, for
 * routine work, tell the agent to skip the brainstorm/plan/tdd ceremony. Off unless
 * `harness.triage` is true. Pure and deterministic: no model call, no I/O.
 *
 * Doubt resolves to "complex": a routine verdict removes pipeline stages, a complex verdict leaves the
 * harness prompt exactly as it is.
 * Reference: MiMo Code v0.1.11 packages/opencode/src/agent/agent.ts:215 marks compose deprecated for
 * strong models ("use Build"); MiMo has no per-request triage, so the signals below are Hordecode's.
 */
export type TriageLimits = {
  /** A request longer than this many characters is complex. */
  maxChars: number
  /** More distinct file or directory paths than this makes the request complex. */
  maxFiles: number
  /** This many numbered or bulleted items or more makes the request complex. */
  maxListItems: number
}

export const DEFAULT_TRIAGE_LIMITS: TriageLimits = { maxChars: 600, maxFiles: 3, maxListItems: 3 }

export type Triage = {
  class: "routine" | "complex"
  /** Why: the signals that decided the class, in a fixed order. */
  signals: string[]
  chars: number
  files: number
}

const PLAN_REQUEST =
  /\b(plan|design|architect(?:ure)?|roadmap|brainstorm|proposal|rfc|spec(?:ification)?|migrat(?:e|ion)|refactor|rewrite|from scratch|step[- ]by[- ]step|think (?:it )?through|full pipeline|harness pipeline)\b/i

// Breadth words: the request reaches past what it names.
const BREADTH = /\b(everywhere|across the|entire|whole|every|all (?:the )?(?:files|tests|callers|usages|call sites|modules|packages))\b/i

const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sh|yml|yaml|toml|css|scss|html|sql|txt|lock"
const FILE_NAME = new RegExp(`(?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${FILE_EXT})\\b`, "gi")
// A directory mention needs two or more path segments ("src/session/x") or a trailing slash ("src/"); "and/or" is not a path.
const DIR_PATH = /(?:^|[\s`'"(])((?:[\w.@-]+\/){2,}[\w.@-]*|[\w.@-]+\/)(?=[\s`'",;:)]|$)/g
const URL = /https?:\/\/\S+/gi
const CODE_TOKEN = /`[^`\n]+`|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b|\w\(\)/
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+\S/gm

function pathsIn(text: string) {
  const bare = text.replace(URL, " ")
  const found = new Set<string>()
  for (const m of bare.matchAll(FILE_NAME)) found.add(m[0].toLowerCase())
  for (const m of bare.matchAll(DIR_PATH)) {
    const p = m[1].replace(/\/+$/, "").toLowerCase()
    if (p && !found.has(p)) found.add(p)
  }
  return found
}

export function classifyRequest(text: string, limits: TriageLimits = DEFAULT_TRIAGE_LIMITS): Triage {
  const request = text.trim()
  const chars = request.length
  const files = pathsIn(request).size
  const complex: string[] = []
  if (chars === 0) complex.push("empty request")
  if (chars > limits.maxChars) complex.push(`length ${chars} > ${limits.maxChars}`)
  if (files > limits.maxFiles) complex.push(`files ${files} > ${limits.maxFiles}`)
  const plan = request.match(PLAN_REQUEST)
  if (plan) complex.push(`plan request "${plan[0].toLowerCase()}"`)
  const breadth = request.match(BREADTH)
  if (breadth) complex.push(`breadth word "${breadth[0].toLowerCase()}"`)
  const items = (request.match(LIST_ITEM) ?? []).length
  if (items >= limits.maxListItems) complex.push(`list items ${items} >= ${limits.maxListItems}`)
  if (files === 0 && !CODE_TOKEN.test(request)) complex.push("no file or code reference")
  if (complex.length > 0) return { class: "complex", signals: complex, chars, files }
  return { class: "routine", signals: [`length ${chars} <= ${limits.maxChars}`, `files ${files} <= ${limits.maxFiles}`, "no plan request"], chars, files }
}

type MessageLike = {
  info: { role: string }
  parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>
}

/** Text of the latest real user request: the last user message with a non-synthetic text part. */
export function requestText(msgs: ReadonlyArray<MessageLike>): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role !== "user") continue
    const texts = msg.parts.filter((p) => p.type === "text" && p.synthetic !== true && p.ignored !== true && p.text)
    if (texts.length > 0) return texts.map((p) => p.text).join("\n")
  }
  return ""
}

/** The text appended to the injected harness prompt. Empty unless the request is routine. */
export function triageSection(triage: Triage): string {
  if (triage.class !== "routine") return ""
  return [
    "",
    "",
    "## Triage: routine request",
    "",
    `This request was classified routine (${triage.signals.join(", ")}). For this request only, this section overrides the pipeline sequence and the eval rule above:`,
    "",
    "- Do not run harness:brainstorm, harness:plan or harness:tdd.",
    "- Implement directly (harness:execute), then run harness:verify with its evidence gate.",
    "- Do not run harness:review, harness:report, harness:eval or harness:merge unless the user asks for them.",
    "- If the work turns out to touch many files or needs design decisions, say so and continue with the full sequence from harness:brainstorm.",
    "",
  ].join("\n")
}
