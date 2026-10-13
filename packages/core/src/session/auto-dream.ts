import { Effect } from "effect"
import { Database, eq, desc, asc, isNull } from "@opencode-ai/core/storage"
import { SessionTable } from "./sql"
import { Log } from "@opencode-ai/core/util"
import { isMemoryWriteEnabled } from "@opencode-ai/memory/write-gate"

const log = Log.create({ service: "auto-dream" })

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DREAM_INTERVAL_DAYS = 7
const DEFAULT_DISTILL_INTERVAL_DAYS = 30
const MIN_SPAWN_GAP_MS = 10_000

export const AUTO_DREAM_TITLE = "Auto Dream"
export const AUTO_DISTILL_TITLE = "Auto Distill"

const SYSTEM_SESSION_TITLES: ReadonlySet<string> = new Set([AUTO_DREAM_TITLE, AUTO_DISTILL_TITLE])

export function isSystemSession(session: { title: string }): boolean {
  return SYSTEM_SESSION_TITLES.has(session.title)
}

let lastDreamSpawnTime = 0
let lastDistillSpawnTime = 0

// Test-only: reset the debounce timestamps. Production code never calls this;
// tests need it because shouldAutoDream/shouldAutoDistill mutate module-level
// state and there's no other way to make sequential tests independent without
// adding real wall-clock sleeps (which would add 10s of test time per call).
// Exported with a __ prefix so the lint surface flags any non-test caller.
export function __resetDebounceForTest() {
  lastDreamSpawnTime = 0
  lastDistillSpawnTime = 0
}

export const DREAM_TASK = [
  "Run one automatic dream memory consolidation pass for the current project.",
  "",
  "Use the memory files as the working index and the raw hordecode trajectory database as the source of truth.",
  "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
  "Consolidate only durable, verified information into project memory.",
].join("\n")

export const DISTILL_TASK = [
  "Run one automatic distill pass for the current project.",
  "",
  "Review the past month of sessions and identify repeated manual workflows worth packaging.",
  "Use the raw hordecode trajectory database as the source of truth and memory files to spot cross-session patterns.",
  "Inventory existing skills, agents, and commands first so you reuse or extend instead of duplicating.",
  "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
  "Produce a compact shortlist, then create only the high-confidence missing assets.",
].join("\n")

function shouldAutoRun(input: {
  enabled: boolean
  intervalDays: number
  title: string
  label: string
}) {
  return Effect.gen(function* () {
    if (!input.enabled) return false

    const intervalMs = input.intervalDays * DAY_MS

    const lastRun = yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .select({ time_created: SessionTable.time_created })
          .from(SessionTable)
          .where(eq(SessionTable.title, input.title))
          .orderBy(desc(SessionTable.time_created))
          .limit(1)
          .get(),
      ),
    )

    const now = Date.now()
    const elapsed = lastRun ? now - lastRun.time_created : Infinity

    if (!lastRun) {
      const earliest = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ time_created: SessionTable.time_created })
            .from(SessionTable)
            .where(isNull(SessionTable.parent_id))
            .orderBy(asc(SessionTable.time_created))
            .limit(1)
            .get(),
        ),
      )
      if (!earliest || now - earliest.time_created < intervalMs) {
        log.info(`auto-${input.label} skipped — project too young`, {
          projectAge: earliest ? Math.round((now - earliest.time_created) / DAY_MS) + "d" : "empty",
          interval: input.intervalDays + "d",
        })
        return false
      }
    }

    if (elapsed < intervalMs) {
      log.info(`auto-${input.label} skipped — last run too recent`, {
        lastRunAgo: Math.round(elapsed / DAY_MS) + "d",
        interval: input.intervalDays + "d",
      })
      return false
    }

    log.info(`auto-${input.label} triggering`, {
      lastRun: lastRun ? new Date(lastRun.time_created).toISOString() : "never",
      interval: input.intervalDays + "d",
    })
    return true
  })
}

export type AutoDreamConfig = {
  dream?: { auto?: boolean; interval_days?: number }
  distill?: { auto?: boolean; interval_days?: number }
  memory?: { disable_write?: boolean }
}

export function shouldAutoDream(cfg: AutoDreamConfig) {
  // Memory writing off -> the consolidation pass that rewrites project memory
  // must not run either. Ported from v0.1.11 auto-dream.ts:113.
  if (!isMemoryWriteEnabled(cfg)) return Effect.succeed(false)
  const enabled = cfg.dream?.auto === true
  if (!enabled) return Effect.succeed(false)
  const now = Date.now()
  if (now - lastDreamSpawnTime < MIN_SPAWN_GAP_MS) return Effect.succeed(false)
  lastDreamSpawnTime = now
  const intervalDays = cfg.dream?.interval_days ?? DEFAULT_DREAM_INTERVAL_DAYS
  return shouldAutoRun({ enabled, intervalDays, title: AUTO_DREAM_TITLE, label: "dream" })
}

export function shouldAutoDistill(cfg: AutoDreamConfig) {
  // Distill reads memory to mine patterns and then auto-produces artifacts in the
  // background. With writing off, nothing should be produced automatically.
  // Ported from v0.1.11 auto-dream.ts:126.
  if (!isMemoryWriteEnabled(cfg)) return Effect.succeed(false)
  const enabled = cfg.distill?.auto === true
  if (!enabled) return Effect.succeed(false)
  const now = Date.now()
  if (now - lastDistillSpawnTime < MIN_SPAWN_GAP_MS) return Effect.succeed(false)
  lastDistillSpawnTime = now
  const intervalDays = cfg.distill?.interval_days ?? DEFAULT_DISTILL_INTERVAL_DAYS
  return shouldAutoRun({ enabled, intervalDays, title: AUTO_DISTILL_TITLE, label: "distill" })
}

export * as AutoDream from "./auto-dream"
