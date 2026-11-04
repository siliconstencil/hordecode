/**
 * Harness triage: classify the user's request as routine or complex from cheap signals and, for
 * routine work, tell the agent to skip the brainstorm/plan/tdd ceremony. Off unless
 * `harness.triage` is true. Pure and deterministic: no model call, no I/O.
 *
 * Doubt resolves to "complex" by construction: complex is the default and a request is routine only when it
 * has the exact shape of a mechanical edit (all of: one sentence, one named file, ASCII English text, a verb
 * phrase from a short allow-list such as "fix the typo" or "bump the version", and none of the plan, breadth
 * or compound-request signals). A routine verdict removes pipeline stages, a complex verdict leaves the
 * harness prompt exactly as it is. Language-neutral by design: text that is not mostly ASCII letters is
 * complex, so a non-English request never skips the pipeline.
 * Reference: MiMo Code v0.1.11 packages/opencode/src/agent/agent.ts:215 marks compose deprecated for
 * strong models ("use Build"); MiMo has no per-request triage, so the signals below are Hordecode's.
 */
export type TriageLimits = {
  /** A request longer than this many characters is complex. */
  maxChars: number
  /** More distinct file or directory paths than this makes the request complex (routine needs exactly one). */
  maxFiles: number
  /** This many numbered or bulleted items or more makes the request complex. */
  maxListItems: number
}

export const DEFAULT_TRIAGE_LIMITS: TriageLimits = { maxChars: 300, maxFiles: 1, maxListItems: 2 }

export type Triage = {
  class: "routine" | "complex"
  /** Why: the signals that decided the class, in a fixed order. */
  signals: string[]
  chars: number
  files: number
}

/** The only shapes that may skip the pipeline: mechanical edits that need no requirements or design. */
const ROUTINE_SHAPE =
  /\b(?:fix(?:ing)?\s+(?:the\s+|a\s+|an\s+)?(?:typos?|spelling|misspell\w*|indent\w*|whitespace|formatting|unused imports?|import order)|(?:remove|delete)\s+(?:the\s+|an?\s+)?unused\s+\w+|bump\s+(?:the\s+)?version|(?:add|fix|update|correct)\s+(?:the\s+|an?\s+)?(?:comments?|docstrings?|jsdoc|readme|changelog)|re-?format|re-?indent)\b/i

const PLAN_REQUEST =
  /\b(plan|design|architect(?:ure)?|roadmap|brainstorm|proposal|rfc|spec(?:ification)?|migrat(?:e|ion)|refactor|rewrite|from scratch|step[- ]by[- ]step|think (?:it )?through|full pipeline|harness pipeline)\b/i

// Breadth words: the request reaches past what it names.
const BREADTH = /\b(everywhere|across the|entire|whole|every|all (?:the )?(?:files|tests|callers|usages|call sites|modules|packages))\b/i

// Compound or open requests: more than one task, or an invitation to do more.
const COMPOUND = /\b(and|then|also|plus|as well|too|while you|additionally|etc|similar|related|others?)\b/i

const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sh|yml|yaml|toml|css|scss|html|sql|txt|lock"
const FILE_NAME = new RegExp(`(?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${FILE_EXT})\\b`, "gi")
// A directory mention needs two or more path segments ("src/session/x") or a trailing slash ("src/"); "and/or" is not a path.
const DIR_PATH = /(?:^|[\s`'"(])((?:[\w.@-]+\/){2,}[\w.@-]*|[\w.@-]+\/)(?=[\s`'",;:)]|$)/g
const URL = /https?:\/\/\S+/gi
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+\S/gm
const NON_ASCII_LETTER_RATIO = 0.05

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

/** The request without urls and paths, so a word inside a file name ("util.spec.ts", "docs/plan.md") is not a signal. */
function prose(text: string) {
  return text
    .replace(URL, " ")
    .replace(FILE_NAME, " ")
    .replace(DIR_PATH, " ")
}

function nonAsciiLetters(text: string) {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return 0
  return letters.filter((c) => !/[A-Za-z]/.test(c)).length / letters.length
}

export function classifyRequest(text: string, limits: TriageLimits = DEFAULT_TRIAGE_LIMITS): Triage {
  const request = text.trim()
  const chars = request.length
  const files = pathsIn(request).size
  const words = prose(request)
  const complex: string[] = []
  if (chars === 0) complex.push("empty request")
  if (chars > limits.maxChars) complex.push(`length ${chars} > ${limits.maxChars}`)
  if (nonAsciiLetters(request) > NON_ASCII_LETTER_RATIO) complex.push("text is not mostly ASCII (language not recognised)")
  if (files > limits.maxFiles) complex.push(`files ${files} > ${limits.maxFiles}`)
  if (files === 0) complex.push("no file named (unknown scope)")
  const plan = words.match(PLAN_REQUEST)
  if (plan) complex.push(`plan request "${plan[0].toLowerCase()}"`)
  const breadth = words.match(BREADTH)
  if (breadth) complex.push(`breadth word "${breadth[0].toLowerCase()}"`)
  const compound = words.match(COMPOUND)
  if (compound) complex.push(`compound request "${compound[0].toLowerCase()}"`)
  const items = (request.match(LIST_ITEM) ?? []).length
  if (items >= limits.maxListItems) complex.push(`list items ${items} >= ${limits.maxListItems}`)
  if (/\n\s*\S/.test(request)) complex.push("more than one line")
  if (words.split(/[.!?;]+(?:\s|$)/).filter((part) => part.trim()).length > 1) complex.push("more than one sentence")
  const shape = words.match(ROUTINE_SHAPE)
  if (!shape) complex.push("not a known mechanical edit")
  if (complex.length > 0) return { class: "complex", signals: complex, chars, files }
  return {
    class: "routine",
    signals: [`length ${chars} <= ${limits.maxChars}`, `files ${files}`, `mechanical edit "${shape![0].toLowerCase()}"`],
    chars,
    files,
  }
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

/** The text inserted inside the harness prompt's system-reminder block. Empty unless the request is routine. */
export function triageSection(triage: Triage): string {
  if (triage.class !== "routine") return ""
  return [
    "## Triage: routine request",
    "",
    `This request was classified routine (${triage.signals.join(", ")}). For this request only, this section overrides the pipeline sequence and the eval rule above:`,
    "",
    "- Do not run harness:brainstorm, harness:plan or harness:tdd.",
    "- Implement directly (harness:execute), then run harness:verify with its evidence gate.",
    "- Do not run harness:review, harness:report, harness:eval or harness:merge unless the user asks for them.",
    "- If the work turns out to touch many files or needs design decisions, say so and continue with the full sequence from harness:brainstorm.",
    "",
    "",
  ].join("\n")
}

/** Puts the section under the same authority as the rest of the prompt: before the final closing tag. */
export function withTriageSection(prompt: string, section: string): string {
  if (!section) return prompt
  const close = prompt.lastIndexOf("</system-reminder>")
  if (close === -1) return prompt + "\n" + section
  return prompt.slice(0, close) + section + prompt.slice(close)
}
