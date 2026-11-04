import { randomUUID } from "node:crypto"
import z from "zod"
import { CONTRACT_DECISIONS } from "./contract-decisions"

export const CriterionState = z.enum(["pending", "passed", "failed", "blocked"])
export type CriterionState = z.infer<typeof CriterionState>

export const Baseline = z.union([
  z.object({ tests_run: z.number(), tests_passed: z.number(), tool: z.string() }),
  z.object({ none: z.string() }),
])
export type Baseline = z.infer<typeof Baseline>

export const Criterion = z.object({
  id: z.string(),
  command: z.string(),
  required: z.boolean(),
  state: CriterionState,
  /** Test count seen when the contract was armed, or why there is none. Absent when the baseline run is off. */
  baseline: Baseline.optional(),
})
export type Criterion = z.infer<typeof Criterion>

export const Breach = z.object({
  cap: z.enum(["wall_ms", "tool_calls", "cost_usd"]),
  limit: z.number(),
  observed: z.number(),
})
export type Breach = z.infer<typeof Breach>

export const Envelope = z.object({
  max_react: z.number(),
  max_wall_ms: z.number().optional(),
  max_tool_calls: z.number().optional(),
  max_cost_usd: z.number().optional(),
})
export type Envelope = z.infer<typeof Envelope>

export const Usage = z.object({ tool_calls: z.number(), cost_usd: z.number() })
export type Usage = z.infer<typeof Usage>

export const Evidence = z.object({
  criterion_id: z.string(),
  attempt: z.number(),
  exit_code: z.number().nullable(),
  timed_out: z.boolean(),
  output_sha256: z.string(),
  started_at: z.number(),
  duration_ms: z.number(),
  log_path: z.string().optional(),
  breach: Breach.optional(),
  /** Test counts parsed from the run output, when it was a recognized summary. */
  tests: z.object({ run: z.number(), passed: z.number() }).optional(),
  /** Why a run with exit code 0 still failed (test count check). */
  note: z.string().optional(),
})
export type Evidence = z.infer<typeof Evidence>

export const Status = z.enum(["active", "verified", "failed", "blocked", "unverified"])
export type Status = z.infer<typeof Status>

export const Contract = z.object({
  id: z.string(),
  session_id: z.string(),
  objective: z.string(),
  criteria: z.array(Criterion),
  envelope: Envelope,
  /** Running totals of the session tree since arm. Only ever raised (see recordUsage); survives compaction, revert and loop restarts. */
  usage: Usage,
  baseline: z.object({
    protected_hashes: z.record(z.string(), z.string()),
    protect_paths: z.array(z.string()),
    git_checkpoint: z.object({ ref: z.string(), sha: z.string() }).optional(),
    git_checkpoint_skipped: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  status: Status,
  reason: z.string().optional(),
  reentries: z.number(),
  evidence: z.array(Evidence),
  violations: z
    .object({
      modified: z.array(z.string()),
      deleted: z.array(z.string()),
      added: z.array(z.string()),
      config_added: z.array(z.string()).optional(),
      added_allowed: z.boolean().optional(),
    })
    .optional(),
  /** Criteria commands approved at arm time (unattended contracts). An unattended run of any other command is blocked. */
  approved_commands: z.array(z.string()),
  unattended: z.boolean(),
  approved_at: z.number().optional(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type Contract = z.infer<typeof Contract>

export type Caps = { wall_ms?: number; tool_calls?: number; cost_usd?: number }
export type Spec = {
  objective: string
  criteria: string[]
  protect: string[]
  unattended: boolean
  checkpoint?: boolean
  caps?: Caps
  /** false: skip the arm-time baseline run (`no-baseline` segment). Absent counts as true. */
  baseline?: boolean
}

const SEPARATOR = /\r?\n|\s;;\s/
const KEYWORD = /^(unattended|checkpoint|no-baseline)$/i
const PREFIX = /^(protect|cap):/i

const WALL_UNIT = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const

function parseCap(text: string, caps: Caps): string | undefined {
  const m = /^(wall|tools|cost)\s+(\S+)$/i.exec(text)
  if (!m) return `Unknown cap "${text}". Use cap: wall <30s|90m|2h>, cap: tools <n> or cap: cost <usd>.`
  const kind = m[1]!.toLowerCase()
  const raw = m[2]!
  if (kind === "wall") {
    const w = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(raw)
    if (!w || Number(w[1]) <= 0) return `cap: wall needs a positive duration with a unit (30s, 90m, 2h), got "${raw}".`
    if (caps.wall_ms !== undefined) return "cap: wall is given twice."
    caps.wall_ms = Math.round(Number(w[1]) * WALL_UNIT[w[2]!.toLowerCase() as keyof typeof WALL_UNIT])
    return undefined
  }
  if (kind === "tools") {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) return `cap: tools needs a positive integer, got "${raw}".`
    if (caps.tool_calls !== undefined) return "cap: tools is given twice."
    caps.tool_calls = Number(raw)
    return undefined
  }
  const c = /^\$?(\d+(?:\.\d+)?)$/.exec(raw)
  if (!c || Number(c[1]) <= 0) return `cap: cost needs a positive USD amount, got "${raw}".`
  if (caps.cost_usd !== undefined) return "cap: cost is given twice."
  caps.cost_usd = Number(c[1])
  return undefined
}

/**
 * Parse `/contract` arguments. Segments split on newlines or " ;; ". The first segment is the
 * objective. After it: `protect: <path>` names a protected path, `cap: wall|tools|cost <value>` sets an
 * envelope cap, a bare `unattended`, `checkpoint` or `no-baseline` (any case) sets that flag, every other
 * segment is a criterion command.
 */
export function parseSpec(text: string): Spec | string {
  const segments = text
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const [objective, ...rest] = segments
  if (!objective) return "A contract needs an objective."
  if (KEYWORD.test(objective) || PREFIX.test(objective)) return `The first segment is the objective, got "${objective}".`
  const protect = rest.filter((s) => /^protect:/i.test(s)).map((s) => s.slice("protect:".length).trim())
  if (protect.some((p) => p === "")) return "`protect:` needs a path."
  const caps: Caps = {}
  for (const s of rest.filter((s) => /^cap:/i.test(s))) {
    const error = parseCap(s.slice("cap:".length).trim(), caps)
    if (error) return error
  }
  const criteria = rest.filter((s) => !PREFIX.test(s) && !KEYWORD.test(s))
  if (criteria.length === 0) return "A contract needs at least one criterion command after the objective."
  return {
    objective,
    criteria,
    protect,
    unattended: CONTRACT_DECISIONS.unattended || rest.some((s) => /^unattended$/i.test(s)),
    checkpoint: CONTRACT_DECISIONS.checkpointRef || rest.some((s) => /^checkpoint$/i.test(s)),
    baseline: CONTRACT_DECISIONS.testBaseline && !rest.some((s) => /^no-baseline$/i.test(s)),
    caps,
  }
}

const contracts = new Map<string, Contract>()

export const get = (sessionID: string) => contracts.get(sessionID)

export const arm = (input: {
  session_id: string
  spec: Spec
  protected_hashes: Record<string, string>
  git_checkpoint?: { ref: string; sha: string } | { skipped: string }
  approved_at?: number
  approved_commands?: string[]
  warnings?: string[]
  envelope?: Partial<Envelope>
  now?: number
}) => {
  const now = input.now ?? Date.now()
  const contract: Contract = {
    id: `ctr_${randomUUID().slice(0, 8)}`,
    session_id: input.session_id,
    objective: input.spec.objective,
    criteria: input.spec.criteria.map((command, i) => ({ id: `C${i + 1}`, command, required: true, state: "pending" })),
    usage: { tool_calls: 0, cost_usd: 0 },
    envelope: {
      max_react: CONTRACT_DECISIONS.maxReact,
      ...(CONTRACT_DECISIONS.maxWallMs > 0 ? { max_wall_ms: CONTRACT_DECISIONS.maxWallMs } : {}),
      ...(CONTRACT_DECISIONS.maxToolCalls > 0 ? { max_tool_calls: CONTRACT_DECISIONS.maxToolCalls } : {}),
      ...(CONTRACT_DECISIONS.maxCostUsd > 0 ? { max_cost_usd: CONTRACT_DECISIONS.maxCostUsd } : {}),
      ...input.envelope,
    },
    baseline: {
      protected_hashes: input.protected_hashes,
      protect_paths: input.spec.protect,
      ...(input.warnings?.length ? { warnings: input.warnings } : {}),
      ...(input.git_checkpoint && "sha" in input.git_checkpoint ? { git_checkpoint: input.git_checkpoint } : {}),
      ...(input.git_checkpoint && "skipped" in input.git_checkpoint ? { git_checkpoint_skipped: input.git_checkpoint.skipped } : {}),
    },
    status: "active",
    reentries: 0,
    evidence: [],
    unattended: input.spec.unattended,
    approved_commands: input.approved_commands ?? [],
    ...(input.approved_at !== undefined ? { approved_at: input.approved_at } : {}),
    created_at: now,
    updated_at: now,
  }
  contracts.set(input.session_id, contract)
  return contract
}

const put = (sessionID: string, next: (c: Contract) => Contract) => {
  const current = contracts.get(sessionID)
  if (!current) return undefined
  const updated = { ...next(current), updated_at: Date.now() }
  contracts.set(sessionID, updated)
  return updated
}

export const record = (sessionID: string, criterionID: string, state: CriterionState, evidence?: Evidence) =>
  put(sessionID, (c) => ({
    ...c,
    criteria: c.criteria.map((x) => (x.id === criterionID ? { ...x, state } : x)),
    evidence: evidence ? [...c.evidence, evidence] : c.evidence,
  }))

/** Raise the stored totals to at least `seen`; a lower reading (compaction, revert, deleted child) never lowers them. */
export const recordUsage = (sessionID: string, seen: Usage) =>
  put(sessionID, (c) => ({
    ...c,
    usage: {
      tool_calls: Math.max(c.usage.tool_calls, seen.tool_calls),
      cost_usd: Math.max(c.usage.cost_usd, seen.cost_usd),
    },
  }))

export const setCheckpoint = (sessionID: string, checkpoint: { ref: string; sha: string } | { skipped: string }) =>
  put(sessionID, (c) => ({
    ...c,
    baseline: {
      ...c.baseline,
      ...("sha" in checkpoint ? { git_checkpoint: checkpoint } : { git_checkpoint_skipped: checkpoint.skipped }),
    },
  }))

export const setBaseline = (sessionID: string, criterionID: string, baseline: Baseline) =>
  put(sessionID, (c) => ({ ...c, criteria: c.criteria.map((x) => (x.id === criterionID ? { ...x, baseline } : x)) }))

export const addEvidence = (sessionID: string, evidence: Evidence) =>
  put(sessionID, (c) => ({ ...c, evidence: [...c.evidence, evidence] }))

export const setViolations = (sessionID: string, violations: Contract["violations"]) =>
  put(sessionID, (c) => ({ ...c, violations }))

export const bumpReentry = (sessionID: string) => put(sessionID, (c) => ({ ...c, reentries: c.reentries + 1 }))

export const finish = (sessionID: string, status: Exclude<Status, "active">, reason: string) =>
  put(sessionID, (c) => ({ ...c, status, reason }))

export const disarm = (sessionID: string) => contracts.delete(sessionID)

export const __resetForTest = () => contracts.clear()

export const tail = (text: string, chars: number) => (text.length > chars ? "..." + text.slice(text.length - chars) : text)

export function reentryText(contract: Contract, failed: { criterion: Criterion; evidence: Evidence; output: string }[], violations?: string[]) {
  return [
    "<system-reminder>",
    "You are about to finish, but the acceptance criteria of this session's contract are not met.",
    `Objective: ${contract.objective}`,
    ...failed.flatMap((f) => [
      `- ${f.criterion.id} \`${f.criterion.command}\` ${f.evidence.timed_out ? "timed out" : `exited with code ${f.evidence.exit_code}`}${f.evidence.note ? `, but the test check failed: ${f.evidence.note}` : ""}`,
      "  output tail:",
      ...tail(f.output, CONTRACT_DECISIONS.reentryTailChars)
        .split("\n")
        .map((line) => `  | ${line}`),
    ]),
    ...(violations?.length ? ["Protected files changed since the contract was armed:", ...violations.map((v) => `- ${v}`), "Restore them."] : []),
    `Re-entry ${contract.reentries} of ${contract.envelope.max_react}. The product re-runs the criteria itself when you stop; claims in text do not count.`,
    "</system-reminder>",
  ].join("\n")
}
