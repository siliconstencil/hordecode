import z from "zod"
import { SessionID, MessageID } from "@opencode-ai/core/session/schema"

export const SupervisorStatus = z.enum(["pending", "running", "idle"])
export type SupervisorStatus = z.infer<typeof SupervisorStatus>

export const SupervisorOutcome = z.enum(["success", "failure", "cancelled"])
export type SupervisorOutcome = z.infer<typeof SupervisorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Supervisor = z
  .object({
    sessionID: z.string(),
    supervisorID: z.string(),
    mode: SpawnMode,
    parentSupervisorID: z.string().optional(),
    status: SupervisorStatus,
    lastOutcome: SupervisorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: z.string().optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    // Last activity heartbeat. Optional because column is nullable for
    // pre-migration rows / instant between register and first activity.
    lastActivityTime: z.number().optional(),
    lastError: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Supervisor" })
export type Supervisor = z.infer<typeof Supervisor>

// === Liveness detection (scanStalled watchdog) ===
// Ported from the upstream reference implementation's schema.ts:110,140,170
// (DEFAULT_LIVENESS_STALL_MS, DEFAULT_LIVENESS_ABANDON_MS, deriveLiveness).
// Own copy placed in supervisor/src/ because importing the
// opencode/src/tool/fleet.ts copy would create a supervisor -> opencode
// import direction (violates the injection rule). The TUI fleet tool's
// deriveLiveness has different semantics (no abandonMs param, returns
// "failure"/"cancelled" string literals), so a shared helper isn't a 1:1
// fit; this one matches the upstream `Liveness` union precisely.

// T40 stall watchdog scan cadence. Well inside DEFAULT_LIVENESS_STALL_MS (6m)
// so a genuinely stalled supervisor is caught within one scan of flipping to
// `stalled` without hammering the registry.
export const WATCHDOG_SCAN_INTERVAL_MS = 45_000

// Above default Liveness.stallMs (6m), below Liveness.abandonMs (10m).
// Leaves a 240s `stalled` band (~5 scans at 45s), which is enough to debounce
// transient slowdowns without making the user wait long for a real stall
// notification.
export const DEFAULT_LIVENESS_STALL_MS = 6 * 60_000
export const DEFAULT_LIVENESS_ABANDON_MS = 10 * 60_000

export const Liveness = z.enum(["progressing", "stalled", "idle", "failure", "cancelled"])
export type Liveness = z.infer<typeof Liveness>

/**
 * Classify a supervisor's liveness based on (status, lastOutcome, lastActivityTime,
 * time.created) and the current time. Mirrors the upstream `deriveLiveness`
 * exactly:
 *
 * - Terminal (status === "idle" + lastOutcome set): returns the outcome label
 *   ("failure" / "cancelled" / "idle"). The upstream code does this same
 *   dispatch.
 * - Active (status === "running" | "pending"): compares `lastActivityTime`
 *   (falling back to `time.created` for rows where activity has not landed yet)
 *   against `stallMs` / `abandonMs`. Returns "progressing" if within stallMs,
 *   "stalled" if past stallMs but within abandonMs, "idle" if past abandonMs.
 *
 * `now` and the thresholds are injected for deterministic testing -- callers in
 * production omit them to use `Date.now()` and the package defaults.
 */
export function deriveLiveness(
  supervisor: Pick<Supervisor, "status" | "lastOutcome" | "lastActivityTime" | "time">,
  now: number = Date.now(),
  stallMs: number = DEFAULT_LIVENESS_STALL_MS,
  abandonMs: number = DEFAULT_LIVENESS_ABANDON_MS,
): Liveness {
  if (supervisor.status === "idle" && supervisor.lastOutcome !== undefined) {
    if (supervisor.lastOutcome === "failure") return "failure"
    if (supervisor.lastOutcome === "cancelled") return "cancelled"
    return "idle"
  }
  if (supervisor.status === "running" || supervisor.status === "pending") {
    const since = supervisor.lastActivityTime ?? supervisor.time.created
    if (now - since > abandonMs) return "idle"
    return now - since <= stallMs ? "progressing" : "stalled"
  }
  return "idle"
}

