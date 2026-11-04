import { randomUUID } from "node:crypto"
import z from "zod"
import { CONTRACT_DECISIONS } from "./contract-decisions"

export const CriterionState = z.enum(["pending", "passed", "failed", "blocked"])
export type CriterionState = z.infer<typeof CriterionState>

export const Criterion = z.object({
  id: z.string(),
  command: z.string(),
  required: z.boolean(),
  state: CriterionState,
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
  violations: z.object({ modified: z.array(z.string()), deleted: z.array(z.string()), added: z.array(z.string()) }).optional(),
  unattended: z.boolean(),
  approved_at: z.number().optional(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type Contract = z.infer<typeof Contract>

export type Spec = { objective: string; criteria: string[]; protect: string[]; unattended: boolean }

const SEPARATOR = /\r?\n|\s;;\s/

/**
 * Parse `/contract` arguments. Segments split on newlines or " ;; ". The first segment is the
 * objective, a `protect: <path>` segment names a protected path, a bare `unattended` segment sets
 * the unattended flag, every other segment is a criterion command.
 */
export function parseSpec(text: string): Spec | string {
  const segments = text
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const [objective, ...rest] = segments
  if (!objective) return "A contract needs an objective."
  const protect = rest.filter((s) => s.startsWith("protect:")).map((s) => s.slice("protect:".length).trim())
  if (protect.some((p) => p === "")) return "`protect:` needs a path."
  const criteria = rest.filter((s) => !s.startsWith("protect:") && s !== "unattended")
  if (criteria.length === 0) return "A contract needs at least one criterion command after the objective."
  return { objective, criteria, protect, unattended: CONTRACT_DECISIONS.unattended || rest.includes("unattended") }
}

const contracts = new Map<string, Contract>()

export const get = (sessionID: string) => contracts.get(sessionID)

export const arm = (input: {
  session_id: string
  spec: Spec
  protected_hashes: Record<string, string>
  git_checkpoint?: { ref: string; sha: string } | { skipped: string }
  approved_at?: number
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
      `- ${f.criterion.id} \`${f.criterion.command}\` ${f.evidence.timed_out ? "timed out" : `exited with code ${f.evidence.exit_code}`}`,
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
