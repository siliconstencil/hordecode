import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/global"
import { Bus } from "@opencode-ai/bus"
import { Config } from "../config/index"
import * as DatabaseModule from "../database/database"
import { Memory } from "@opencode-ai/memory"
import { MemoryFtsTable } from "@opencode-ai/memory/fts.sql"
import { isMemoryWriteEnabled } from "@opencode-ai/memory/write-gate"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { AgentOutcome, FailureInfo, ForkContext } from "@opencode-ai/supervisor/spawn"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { prefixCaptureRef } from "./prefix-capture-ref"
import { Database, and, eq, or } from "@opencode-ai/core/storage"
import { SessionStatus } from "./status"
import { Instance } from "@opencode-ai/project/instance"
import { ProjectID } from "@opencode-ai/project/schema"
import { InstanceState } from "@opencode-ai/core/effect"
import { InstanceRef, WorkspaceRef } from "@opencode-ai/core/effect/instance-ref"
import { LocalContext } from "@opencode-ai/core/util"
import { WorkspaceContext } from "@opencode-ai/control-plane/workspace-context"
import { SessionTable } from "./session.sql"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { Log, Token } from "../util"
import { Effect, Layer, Deferred, Context, Scope, Fiber, Exit } from "effect"
import { makeRuntime } from "@opencode-ai/core/effect/run-service"
import type { SupervisorPromptOps } from "./supervisor-prompt-ops"
import type { ProviderID, ModelID } from "../provider/schema"
import PROMPT_CHECKPOINT_WRITER from "@opencode-ai/agent/prompt/checkpoint-writer.txt"
import { WriterCachePerf } from "@opencode-ai/supervisor/events"
import {
  metaDir,
  checkpointPath,
  memoryPath,
  notesPath,
  globalMemoryPath,
  migrateProjectMemory,
} from "./checkpoint-paths"
import { readBudgeted, readBudgetedSectionAware } from "./budgeted-read"
import type { LastMessageInfo } from "./last-message-info"
import { CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, NOTES_TEMPLATE, CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"
import { adjustBoundaryForApiInvariants } from "./boundary"
import { alignToNonToolResultUser } from "./checkpoint-align"
import { loadPriorDiscoveredTitles } from "./checkpoint-retry"
import * as CheckpointContext from "./checkpoint-context"
import { buildProgressDiff } from "./checkpoint-progress-reconcile"

const log = Log.create({ service: "session.checkpoint" })

// The checkpoint writer's own timeout: the writer's Deferred.await gives up
// after this many milliseconds. No caller may wait for a writer for less than
// this -- a shorter wait cannot observe a settlement the writer itself would
// still have produced, it only abandons a writer that was about to finish.
//
// The exit drain bounds are this value on purpose. The 0.1.6 lab measured
// 10/10 discarded paid writer runs dying exactly at the drain's old 60 s
// bound (build-worktrees/tmp/g2b-step1-findings.md): 0.0725 of the 0.0811 USD
// discarded cost was billed inside the drain window. The longest measured
// writer run was 55.2 s over 36 runs, so any bound below the writer's own
// timeout throws away writers that were already in flight.
export const CHECKPOINT_WRITER_TIMEOUT_MS = 600_000

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 60) + "\n... (truncated, full body at file)"
}

/**
 * Truncate verbatim user input that exceeds per-message cap. Keeps head (~60%)
 * + tail (~30%) with an elision marker pointing at messageID for full recall
 * via the history tool's operation=around. ~4 chars/token approximation matches
 * Token.estimate.
 */
function truncateVerbatimUserMsg(text: string, capTokens: number, messageID: string): string {
  if (Token.estimate(text) <= capTokens) return text
  // slice() cuts on UTF-16 code units, which can split a surrogate pair at the
  // boundary; trim a dangling high surrogate off the head and a leading low
  // surrogate off the tail so emoji / non-BMP chars don't render as garbage.
  const head = text.slice(0, Math.floor(capTokens * 0.6) * 4).replace(/[\uD800-\uDBFF]$/, "")
  const tail = text.slice(-Math.floor(capTokens * 0.3) * 4).replace(/^[\uDC00-\uDFFF]/, "")
  const elidedTokens = Token.estimate(text) - Token.estimate(head) - Token.estimate(tail)
  return [
    head,
    `[\u2026elided ${elidedTokens} tokens; messageID=${messageID}; use the history tool with operation=around to fetch full content]`,
    tail,
  ].join("\n")
}

/**
 * Concatenate text-typed parts of a user message into a single string. Skips
 * tool/file/image/etc. parts and synthetic text (e.g. rebuild-boundary content
 * injected by insertRebuildBoundary) -- only true user prose contributes.
 */
function userMsgText(parts: Array<{ type: string; text?: string; synthetic?: boolean }>): string {
  return parts
    .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text!)
    .join("\n")
}

function autonomousLoopReminder(): string {
  return [
    "<system-reminder>",
    "You are mid-loop in an autonomous task. Continue your work loop:",
    "respond to the tool results below and proceed to the next iteration.",
    "</system-reminder>",
  ].join("\n")
}

function stopReminder(focusTaskID: string | undefined): string {
  const taskHint = focusTaskID
    ? `Consult this session's tasks/${focusTaskID}/progress.md head section.`
    : "Consult the most recently active task's progress.md head section."
  return [
    "<system-reminder>",
    "The previous assistant turn ended with a stop. Before stopping again,",
    taskHint,
    "Compare the Task spec to the latest Progress entries. If the task is",
    "incomplete, proceed to the next concrete step. Only stop when the spec",
    "is genuinely satisfied or you need user input you cannot infer.",
    "</system-reminder>",
  ].join("\n")
}

function toolResultContinueReminder(): string {
  return [
    "<system-reminder>",
    "Tool results above are real history from the autonomous loop. Process",
    "them and continue to the next iteration. Do not pause to summarize.",
    "</system-reminder>",
  ].join("\n")
}

async function ensureCheckpointTemplate(checkpointFile: string): Promise<void> {
  if (!(await Bun.file(checkpointFile).exists())) {
    await fs.mkdir(path.dirname(checkpointFile), { recursive: true })
    await Bun.write(checkpointFile, CHECKPOINT_TEMPLATE)
  }
}

async function ensureMemoryTemplate(memoryFile: string): Promise<void> {
  if (!(await Bun.file(memoryFile).exists())) {
    await fs.mkdir(path.dirname(memoryFile), { recursive: true })
    await Bun.write(memoryFile, MEMORY_TEMPLATE)
  }
}

async function ensureNotesTemplate(notesFile: string): Promise<void> {
  if (!(await Bun.file(notesFile).exists())) {
    await fs.mkdir(path.dirname(notesFile), { recursive: true })
    await Bun.write(notesFile, NOTES_TEMPLATE)
  }
}

// Tail preservation budget (token-budgeted boundary).
// Session-memory compact: minimum guarantees the LLM has enough
// recent-context anchor (avoids the agent-Read-loop failure mode from
// v4 -> v5 spec rationale); maximum is a SOFT ceiling on backward
// expansion -- i.e. when the natural tail is below the floor we expand
// backward UP TO maxTokens, but if the natural tail already exceeds
// maxTokens we leave it alone. Single-message-granularity cap would
// break tool_use/result pairing.
//
// 20K is the empirical sweet spot -- observed compact output is ~20K,
// not the 40K nominal default. The 40K appears in source as fallback,
// but the upstream config likely tunes it lower in production.
const TAIL_MIN_TOKENS = 10_000
const TAIL_MAX_TOKENS = 20_000
const TAIL_MIN_TEXT_BLOCK_MESSAGES = 5

// session-end idle trigger -- "meaningful content" gate.
//
// Short real sessions (a few turns, well under the 20K compaction threshold)
// never hit the compaction-triggered writer and would otherwise leave no
// checkpoint.md at all. This trigger is a SECOND independent path that fires
// on session idle, additive to compaction, reusing the same writer.
//
// 3 user turns / 2 tool calls is the empirical sweet spot -- mirrors the
// threshold-picking style at line 148 (20K tail sweet spot):
// - 1 turn = greeting / trivial Q&A -- never worth checkpointing (noise).
// - 2 turns = common follow-up but usually ephemeral; still below recall value.
// - 3 user turns signals sustained intent worth remembering (real task, not a probe).
// - 2 tool calls signals real execution (e.g. read+edit, bash+write) even in
//   a 1-2 turn session -- should be captured without waiting for a third turn.
// - Tool-call threshold counts actual `tool` parts (completed/running/error),
//   excluding synthetic checkpoint/compaction markers. Trivial single-shot
//   "what's 2+2" with 0-1 tool calls correctly falls below the gate.
// - Debounce (30s) prevents rapid idle flaps in interactive use from
//   spawning duplicate writers; compaction already owns its own dedupe.
const IDLE_MIN_USER_TURNS = 3
const IDLE_MIN_TOOL_CALLS = 2
const IDLE_DEBOUNCE_MS = 30_000
export const IDLE_TRIGGER_CONFIG = {
  minUserTurns: IDLE_MIN_USER_TURNS,
  minToolCalls: IDLE_MIN_TOOL_CALLS,
  debounceMs: IDLE_DEBOUNCE_MS,
} as const

/**
 * Returns true when the session slice has "meaningful" content worth
 * checkpointing on idle. Predicate is OR: >=3 user turns OR >=2 tool calls.
 * Empty/trivial (1-line Q&A, 0-1 tool calls, <3 turns) returns false.
 */
export function isIdleCheckpointEligible(input: {
  userTurns: number
  toolCalls: number
}): boolean {
  if (input.userTurns >= IDLE_MIN_USER_TURNS) return true
  if (input.toolCalls >= IDLE_MIN_TOOL_CALLS) return true
  return false
}

/**
 * Convenience helper used by the idle trigger: count user turns and tool
 * calls from a MessageV2 slice. User turns count role:"user" messages that
 * are not synthetic checkpoint/compaction markers. Tool calls count `tool`
 * parts across all messages.
 */
export function countIdleSignals(
  msgs: ReadonlyArray<{ info: { role: string }; parts: Array<{ type: string; synthetic?: boolean }> }>,
): { userTurns: number; toolCalls: number } {
  let userTurns = 0
  let toolCalls = 0
  for (const m of msgs) {
    if (
      m.info.role === "user" &&
      !m.parts.some((p) => p.type === "checkpoint" || p.type === "compaction")
    ) {
      // Only count user messages that carry real text/tool-free prose, not
      // synthetic rebuild markers. Mirrors userMsgText filtering.
      // The p.type === "text" guard narrows the part to TextPart.
      const hasRealContent = m.parts.some((p) => p.type === "text" && !p.synthetic && (p as MessageV2.TextPart).text?.trim())
      // Fallback: count the message even if text part empty but it's a real
      // user turn (e.g. image/file turn) -- strictly more permissive, safe.
      if (hasRealContent || m.parts.length === 0 || m.parts.some((p) => p.type !== "checkpoint" && p.type !== "compaction"))
        userTurns++
    }
    for (const p of m.parts) if (p.type === "tool") toolCalls++
  }
  return { userTurns, toolCalls }
}

// Rebuild-time microcompact.
//
// After computing the boundary, msgs strictly newer than the boundary
// survive into the rebuild context. Their tool_use parts are kept (so the
// LLM still sees what action was taken), but for tools in this whitelist
// the tool_result content is replaced with a placeholder. Result is either
// large-and-regeneratable (read/bash/grep/glob/webfetch/websearch) or
// essentially a "done" confirmation (edit/write/multiedit). Tools NOT here
// carry state the LLM references later (supervisor/task/question/skill/memory).
const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "read",
  "bash",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "edit",
  "write",
  "multiedit",
  "apply_patch",
])

function estimateMessageTokens(m: { parts: Array<{ type: string; [k: string]: unknown }> }): number {
  // Same estimator used elsewhere in checkpoint.ts (Token.estimate over JSON).
  // Sum across all parts of the message.
  let sum = 0
  for (const p of m.parts) {
    // JSON.stringify throws on circular structures. Parser-produced parts are
    // plain POJOs, but a plugin-injected part could contain a cycle. Fall back
    // to a conservative NON-ZERO estimate so a bad part is never counted as
    // "free" -- a 0 here would let the tail-boundary algorithm swallow the part
    // for nothing and skew the budget. The constant overstates a typical part,
    // which is the safe direction (boundary walks back, never forward).
    try {
      sum += Token.estimate(JSON.stringify(p))
    } catch {
      sum += 1000
    }
  }
  return sum
}

// Fork-only (Hordecode). A rebuild inserts its synthetic boundary message
// back-dated to the coveredUpTo message's timestamp, so filterCompacted keeps
// the boundary and everything after it: the messages strictly before the
// boundary are exactly what a rebuild discards. Callers use this to reject a
// checkpoint whose boundary is too old to bound the context. No MiMo
// v0.1.11/0.1.12 equivalent (they reuse coveredUpTo without this check).
export function estimateTokensBeforeBoundary(
  msgs: ReadonlyArray<{ info: { id: string }; parts: Array<{ type: string; [k: string]: unknown }> }>,
  boundary: string,
): number {
  const index = msgs.findIndex((m) => m.info.id === boundary)
  if (index <= 0) return 0
  let sum = 0
  for (let i = 0; i < index; i++) sum += estimateMessageTokens(msgs[i])
  return sum
}

function hasTextBlocks(m: { parts: Array<{ type: string }> }): boolean {
  return m.parts.some((p) => p.type === "text" || p.type === "reasoning")
}

/**
 * Token-budgeted, role-aware boundary choice for the preserved tail.
 *
 * Returns the ID of the FIRST message to preserve (boundary message ID;
 * everything strictly before this ID is summarized into checkpoint.md and
 * discarded from the rebuild context).
 *
 * Algorithm (token-budgeted boundary):
 *
 * 1. Start at the last finished assistant index minus 1, take it+successors
 *    as the candidate tail (preserves spec 2 starting point so reasonable
 *    tails are unchanged).
 * 2. If tail tokens already >= TAIL_MAX_TOKENS: leave boundary as-is and
 *    return. Do NOT pull boundary forward -- message-granularity truncation
 *    would split tool_use/tool_result pairs (downstream
 *    adjustBoundaryForApiInvariants would just walk back, net no-op + risk
 *    of thinking-block breaks). The cap is a SOFT ceiling on backward
 *    expansion, not a hard upper bound on tail size. If a single
 *    assistant turn legitimately produces 60K of tool_result, the tail
 *    will be 60K and that's fine.
 * 3. Else if tail tokens < TAIL_MIN_TOKENS or text-block messages < min:
 *    walk backward (earlier) one message at a time until both minimums
 *    met OR TAIL_MAX_TOKENS hit OR no more messages.
 *
 * The downstream adjustBoundaryForApiInvariants call (in
 * tryStartCheckpointWriter) handles tool_use/tool_result pairing and
 * thinking-block atomicity -- this function does NOT need to.
 *
 * Edge cases:
 * - msgs.length === 0: return "" (matches old behavior).
 * - No finished assistant: return msgs[0].info.id (degenerate; caller should
 *   not be invoking trim here, but stay safe).
 * - lastAsstIdx === 0: return msgs[0].info.id (degenerate tail).
 */
export function computeBoundary(
  msgs: ReadonlyArray<{ info: { id: string; role: "user" | "assistant"; finish?: string }; parts: Array<{ type: string; [k: string]: unknown }> }>,
): string {
  if (msgs.length === 0) return ""
  const lastAsstIdx = msgs.findLastIndex(
    (m) => m.info.role === "assistant" && m.info.finish !== undefined,
  )
  if (lastAsstIdx <= 0) return msgs[lastAsstIdx >= 0 ? lastAsstIdx : 0].info.id

  // Token estimate per message (computed once).
  const tokens = msgs.map((m) => estimateMessageTokens(m))

  // Start one message before the last assistant message.
  let startIdx = lastAsstIdx - 1
  let tailSum = 0
  let textBlockCount = 0
  for (let i = startIdx; i < msgs.length; i++) {
    tailSum += tokens[i]
    if (hasTextBlocks(msgs[i])) textBlockCount += 1
  }

  // Natural tail already >= cap: leave it alone (soft ceiling; do NOT pull
  // boundary forward -- see jsdoc rationale).
  if (tailSum >= TAIL_MAX_TOKENS) {
    return msgs[startIdx].info.id
  }

  // Tail too small -- pull boundary earlier (include more history)
  // until both floors met, capped at TAIL_MAX_TOKENS.
  while (
    startIdx > 0 &&
    tailSum < TAIL_MAX_TOKENS &&
    (tailSum < TAIL_MIN_TOKENS || textBlockCount < TAIL_MIN_TEXT_BLOCK_MESSAGES)
  ) {
    startIdx -= 1
    tailSum += tokens[startIdx]
    if (hasTextBlocks(msgs[startIdx])) textBlockCount += 1
  }
  return msgs[startIdx].info.id
}

function renderSectionBudgets(budgets: Record<string, number>): string {
  const entries = Object.entries(budgets)
  if (entries.length === 0) {
    throw new Error("CHECKPOINT_SECTION_BUDGETS is empty — F43 substitution would produce an empty prompt block")
  }
  const cols = 3
  const lines: string[] = ["Section budgets (~tokens):"]
  for (let i = 0; i < entries.length; i += cols) {
    const row = entries
      .slice(i, i + cols)
      .map(([k, v]) => `${k}: ${v}`)
      .join("    ")
    lines.push(`   ${row}`)
  }
  return lines.join("\n")
}

/**
 * Composes the full writer prompt for the checkpoint subagent.
 *
 * The body wraps PROMPT_CHECKPOINT_WRITER with an ABSOLUTE-PATHS preamble
 * that pins CHECKPOINT_PATH/MEMORY_PATH/TASK_MEM_DIR to the current session's
 * dirs -- without this, the model frequently invents legacy `/data/checkpoints/`
 * style paths from training-data lookalikes.
 */
function composeWriterPrompt(input: {
  checkpointFile: string
  memoryFile: string
  taskMemDir: string
  notesFile: string
  rangeDesc: string
  progressDiff: string  // Spec ② Chain 2: empty string when nothing to reconcile
}): string {
  return [
    "<system-reminder>",
    "You are now operating in checkpoint-writer mode. Ignore the general coding-assistant framing in the system prompt above. The read, write, edit, glob, grep, and task tools are available; do not invoke others.",
    "",
    "========================================================================",
    "ABSOLUTE PATHS — USE THESE VERBATIM. NEVER COMPUTE, INFER, OR MODIFY.",
    "========================================================================",
    "",
    `CHECKPOINT_PATH = ${input.checkpointFile}`,
    `MEMORY_PATH     = ${input.memoryFile}`,
    `TASK_MEM_DIR    = ${input.taskMemDir}`,
    `NOTES_PATH      = ${input.notesFile}`,
    "",
    "When using the Write tool, the first arg MUST be one of these literal",
    "absolute paths (or for task narrative, TASK_MEM_DIR + '/' + task_id +",
    "'/progress.md' or '/notes.md'). Do NOT abbreviate. Do NOT change",
    "parent directories. Do NOT insert paths from memory of similar projects.",
    "If you find yourself typing '/data/checkpoints/' as a parent, STOP — that",
    "is the legacy v2 layout and is wrong. The current parent for the",
    "checkpoint file is the directory portion of CHECKPOINT_PATH above.",
    "========================================================================",
    "",
    input.progressDiff,
    "",
    PROMPT_CHECKPOINT_WRITER.replace("{{SECTION_BUDGETS}}", renderSectionBudgets(CHECKPOINT_SECTION_BUDGETS)),
    "</system-reminder>",
    "",
    `Write the next checkpoint for this session.`,
    "",
    input.rangeDesc,
    "",
    "Use the `task` tool for ALL task state ops (create / start / progress / done / abandon / approve / rename / block / unblock / batch_create). Use the Write tool for the checkpoint, memory, and task narrative files at the CHECKPOINT_PATH / MEMORY_PATH / TASK_MEM_DIR locations declared above. After all writes and tool calls, stop immediately.",
  ].join("\n")
}

function aggregateWriterCacheMetrics(
  sessions: Session.Interface,
  sessionID: SessionID,
  supervisorID: string,
) {
  return Effect.gen(function* () {
    const msgs = yield* sessions.messages({ sessionID, agentID: "*" })
    let totalInput = 0
    let cacheRead = 0
    let cacheWrite = 0
    let assistantCount = 0
    for (const m of msgs) {
      if (m.info.role !== "assistant") continue
      if (m.info.agentID !== supervisorID) continue
      // Count every assistant LLM call in the slice, even ones without
      // billing-token data (errors / mid-stream interrupts). Token sums
      // skip the no-data rows; the call count includes them so downstream
      // consumers can distinguish "low cache hit" from "few calls".
      assistantCount += 1
      const t = m.info.tokens
      if (!t) continue
      totalInput += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      cacheRead += t.cache?.read ?? 0
      cacheWrite += t.cache?.write ?? 0
    }
    const billable = totalInput - cacheRead - cacheWrite
    const denom = cacheRead + Math.max(billable, 0)
    const hitRate = denom > 0 ? cacheRead / denom : 0
    return {
      total_input_tokens: totalInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cache_hit_rate: hitRate,
      num_llm_calls: assistantCount,
    }
  })
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type TryStartCheckpointWriterInput = {
  sessionID: SessionID
  model: { providerID: string; modelID: string }
  promptOps: SupervisorPromptOps
  // Token count at which the request was raised. A request raised at the same
  // or an older level than the running writer cannot cover new history and is
  // skipped instead of queued (duplicate startup writer pair).
  level?: number
}

/**
 * Outcome of a tryStartCheckpointWriter call:
 * - "started": no writer was running for this session, a fresh one was forked.
 * - "queued":  a writer is already running. The new request is held in the
 *              1-slot pending queue and will fire once the current writer
 *              settles. If a pending request already exists it's evicted --
 *              newest wins because its range is a strict superset of the
 *              older pending range, so the older one would just duplicate
 *              work. (F40)
 * - "skipped": the request was rejected outright -- empty session, system-
 *              spawned subagent, or Supervisor service unavailable. No writer
 *              will fire for this request now or later.
 */
export type TryStartCheckpointWriterResult = "started" | "queued" | "skipped"

export interface Interface {
  readonly tryStartCheckpointWriter: (
    input: TryStartCheckpointWriterInput,
  ) => Effect.Effect<TryStartCheckpointWriterResult>

  readonly waitForWriter: (sessionID: SessionID) => Effect.Effect<WriterOutcome | "no-writer">

  /**
   * The same bounded wait as `waitForWriter`, additionally surfacing the
   * failure classification the writer's outcome already carries.
   *
   * `waitForWriter` is #1938's contract -- three flat values, one of which
   * ("timeout") means "still in flight". That contract is deliberately left
   * alone; this is the shape a caller needs when the CLASS of a failure
   * changes what it does next (prune's recovery gate). Both are one
   * implementation: `waitForWriter` projects `.outcome` off this, so the two
   * can never disagree about what a settled writer did.
   */
  readonly waitForWriterSettlement: (sessionID: SessionID) => Effect.Effect<WriterSettlement>

  /**
   * Await all in-flight writers across sessions up to `timeoutMs`. Used by
   * the CLI shutdown path so headless `hordecode run` invocations don't exit
   * while a forked checkpoint writer is still waiting on its LLM round-trip.
   * A writer counts as drained only when it left the writers map, which
   * happens after its watcher advanced the delta watermark. A failed writer is
   * removed from the map too, so `drained` counts every settled writer, not
   * only the successful ones. `timedOut` counts the writers that were still
   * in the map when the bound expired.
   *
   * The writers map is watched, not snapshotted: the drain ends once the map
   * has stayed empty for a short quiescence window. The drain also CLOSES the
   * writer slot while it runs: no new writer is spawned, registered or
   * queued, because a writer that starts while the process is exiting is
   * billed and killed without writing its checkpoint.
   */
  readonly drainWriters: (input?: { timeoutMs?: number }) => Effect.Effect<{
    drained: number
    timedOut: number
  }>

  readonly hasCheckpoint: (sessionID: SessionID) => Effect.Effect<boolean>

  /**
   * Returns true when the session has any memory artifacts:
   * either a populated `<data>/memory/sessions/<sid>/` directory, or
   * any tasks recorded in the task registry. Used by the per-user-message
   * recall reminder so it fires whenever there is anything to recall --
   * not only when classic v2 checkpoints exist.
   */
  readonly hasMemoryOrTasks: (sessionID: SessionID) => Effect.Effect<boolean>

  /** Returns the content of the latest checkpoint file, or undefined if none exists. */
  readonly loadLatest: (sessionID: SessionID) => Effect.Effect<string | undefined>

  /** Returns the content of the last N checkpoint files, ordered oldest to newest. */
  readonly loadCheckpoints: (sessionID: SessionID, count: number) => Effect.Effect<string[]>

  /** Returns a human-readable index overview for injection into rebuild context. */
  readonly renderIndex: (sessionID: SessionID) => Effect.Effect<string>

  /**
   * Returns the rebuild-time context that should be injected after trim.
   * Format:
   *   <system-reminder>Verify-before-act note...</system-reminder>
   *   ## Accumulated learnings (chronological)
   *   ### From checkpoint #1 (<topic>)
   *   <Learning body>
   *   ...
   *   ## Current snapshot (as of checkpoint #N)
   *   <Snapshot body>
   *
   * Stale Snapshots from older checkpoints are intentionally dropped. Returns
   * an empty string if no checkpoints exist. When checkpoints exist but all
   * Learning sections are empty, emits "(no prior learnings)" placeholder;
   * when the latest checkpoint has no Snapshot section, emits
   * "(latest checkpoint has no Snapshot section)" placeholder -- the full
   * structure is always produced so the verify-before-act reminder is
   * consistently visible.
   */
  readonly renderRebuildContext: (
    sessionID: SessionID,
    opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string; skipWriterWait?: boolean },
  ) => Effect.Effect<string>

  readonly lastBoundary: (sessionID: SessionID) => Effect.Effect<MessageID | undefined>

  readonly isWriterRunning: (sessionID: SessionID) => Effect.Effect<boolean>

  /**
   * Additive trigger: attempt a checkpoint on session idle when the
   * session has "meaningful" content (>=3 user turns OR >=2 tool calls).
   * Returns the same TryStart result as the compaction path ("started" /
   * "queued" / "skipped") so callers can observe what happened.
   * This path REUSES the compaction writer (same checkpoint.md mechanism,
   * same Deferred/timeout handling from 3a3a110e50) -- it is a second trigger,
   * not a parallel writer.
   */
  readonly maybeCheckpointOnIdle: (sessionID: SessionID) => Effect.Effect<TryStartCheckpointWriterResult>

  /**
   * Insert a synthetic checkpoint-boundary user message (boundary marker +
   * index overview + rebuild context + active-supervisors text) just after the
   * given boundary. Inserts nothing and returns false when rebuild context is
   * empty or the boundary time is unknown. Never deletes DB messages.
   */
  readonly insertRebuildBoundary: (input: {
    sessionID: SessionID
    boundary: MessageID
    lastMessageInfo?: LastMessageInfo
    agentID?: string
    agent: string
    model: { providerID: string; modelID: string }
    boundaryCreatedAt?: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCheckpoint") {}

// ---------------------------------------------------------------------------
// Writer state per session
// ---------------------------------------------------------------------------

export type WriterOutcome = "success" | "failure" | "timeout"

/**
 * A settled (or bound-expired) writer, plus the classification its
 * AgentOutcome already carried.
 *
 * `failure` is present only when `outcome === "failure"` AND the writer's
 * error was classifiable at the construction site. It is absent for a
 * cancelled writer and for a failure whose error never reached
 * classifyAssistantError -- so "absent" means "unknown class", never
 * "retryable".
 */
export type WriterSettlement = {
  outcome: WriterOutcome | "no-writer"
  failure?: FailureInfo
}

interface WriterState {
  // Holds the AgentOutcome Deferred for the writer. Created at ENTRY, before
  // the fork-context build and the spawn, so a writer between entry and spawn
  // is visible to drainWriters/isWriterRunning. Completed from the turn
  // outcome once the writer hands off to its settle watcher.
  writing: Deferred.Deferred<AgentOutcome>
  // Completes with THIS writer's public outcome after the settle step: the
  // mtime gate plus the watermark update when the writer rewrote
  // checkpoint.md, and before the map entry is deleted. A success without a
  // rewrite deliberately keeps the watermark put. A waiter takes the entry
  // once and awaits this Deferred, so a later writer that replaces the map
  // entry cannot change its answer.
  // FORK_DELTA: MiMo writers.set after spawn
  // (repos/mimocode-v0.1.11/packages/opencode/src/session/checkpoint.ts:956)
  // and writes the watermark later inside the watcher (:976); here the record
  // exists from entry and the waiter settles after that settle step.
  settled: Deferred.Deferred<WriterOutcome>
  // The outcome's FailureInfo, stored before `settled` completes so prune
  // keeps its classification after the entry is gone.
  failure?: FailureInfo
  // Token count at which the running writer was started. Used to drop a
  // request that cannot cover new history (same-level duplicate).
  level?: number
  // F40: 1-slot pending queue. When set, holds the input for a writer that
  // should fire as soon as `writing` settles. Newer requests evict older
  // pending values -- the newest range is always a strict superset of the
  // older one, so older pending checkpoints would only duplicate work.
  pending?: TryStartCheckpointWriterInput
}

// ---------------------------------------------------------------------------
// Layer implementation
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    const taskRegistry = yield* TaskRegistry.Service
    const supervisorRegistry = yield* SupervisorRegistryService.Service

    // A checkpoint-writer child session carries a supervisor registered with
    // agent "checkpoint-writer" (supervisor.spawn stores agentType verbatim at
    // supervisor/spawn.ts). The legacy re-entry guard used
    // `isSystemSpawned(sessionID, "main")`, which the registry hard-returns
    // false for (supervisorID === "main" short-circuit), so it never blocked
    // re-entry. That bug let the writer's own child session re-trigger
    // tryStartCheckpointWriter, cascading infinitely. Detect the
    // writer child by its supervisor agent instead.
    const isCheckpointWriterSession = Effect.fn("SessionCheckpoint.isCheckpointWriterSession")(function* (
      sessionID: SessionID,
    ) {
      const supervisors = yield* supervisorRegistry.listBySession(sessionID)
      return supervisors.some((s) => s.agent === "checkpoint-writer")
    })

    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    // Plain Map in the layer closure -- same approach as compaction.ts
    const writers = new Map<SessionID, WriterState>()
    // G3-D7, reports/0.1.6/g3-one-writer-record.md:214
    // The settlement must outlive the map entry: a caller (prune) waits only
    // after tryStartCheckpointWriter returned "started", and a fast writer can
    // finish inside that window. One record per session, replaced by the next
    // settlement.
    const lastSettlements = new Map<SessionID, WriterSettlement>()
    const releaseWriter = (sessionID: SessionID, state: WriterState, outcome: WriterOutcome) => {
      lastSettlements.set(sessionID, state.failure ? { outcome, failure: state.failure } : { outcome })
      if (writers.get(sessionID) === state) writers.delete(sessionID)
    }
    // The writer slot. A checkpoint writer is a billed LLM round-trip: one
    // that registers while the process is on its way out is killed when the
    // process exits, so its checkpoint is never written and the delta
    // watermark does not advance -- the next writer covers the same delta
    // again. While a drain runs the slot is closed: no writer may be
    // spawned, registered or queued.
    let drainInProgress = false
    // debounce per-session idle triggers to avoid flaps
    const idleLastTrigger = new Map<SessionID, number>()

    const tryStartCheckpointWriter = Effect.fn("SessionCheckpoint.tryStartCheckpointWriter")(function* (
      input: TryStartCheckpointWriterInput,
    ) {
      // The drain closed the writer slot: while a drain is in progress no
      // writer may be spawned, registered or queued. A writer that starts
      // here is billed and killed when the process exits: its checkpoint is
      // not written and the delta watermark does not advance, so the next
      // writer covers the same delta again. The request is dropped -- the
      // delta is re-covered by the next writer.
      if (drainInProgress) {
        log.info("drain in progress, refusing to start a checkpoint writer", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Memory writing disabled -- stop producing NEW memory. This is the single
      // gate for the whole write side of checkpointing: template bootstrap
      // (ensureCheckpointTemplate/ensureMemoryTemplate/ensureNotesTemplate),
      // the writer subagent spawn, and the validator retry rename all live
      // past this point. Reads are untouched -- renderRebuildContext and the
      // memory search tool keep working. Default is ENABLED: absent config
      // writes. The field name and polarity live in exactly one place
      // (memory/write-gate.ts). Ported from v0.1.11 checkpoint.ts:608.
      if (!isMemoryWriteEnabled(yield* config.get())) {
        log.info("memory writing disabled, skipping checkpoint", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Defensive: skip if this session IS a checkpoint-writer child. The writer
      // child's parent loop would otherwise re-trigger this function and cascade.
      // Replaces the dead `isSystemSpawned(sessionID, "main")` guard.
      if (yield* isCheckpointWriterSession(input.sessionID)) {
        log.info("tryStartCheckpointWriter skipping checkpoint-writer session")
        return "skipped" as const
      }

      // The record is created at entry, before the fork-context build and the
      // spawn, so a writer that has passed the gates is visible to the drain
      // and to waiters even while it is still building. The Deferreds are made
      // before the dedupe read; the read and the set below are adjacent with
      // no yield between them, so two concurrent starts cannot both register.
      const writingDeferred = yield* Deferred.make<AgentOutcome>()
      const settledDeferred = yield* Deferred.make<WriterOutcome>()
      const state: WriterState = { writing: writingDeferred, settled: settledDeferred, level: input.level }

      // F40: writer1 still running. Evict any prior pending and queue this
      // request -- newest wins because its range is a strict superset of the
      // older pending range, so older pending checkpoints would only
      // duplicate the work.
      const existing = writers.get(input.sessionID)
      if (existing) {
        // Several thresholds crossed at the same token level call this in one
        // fireCheckpoints pass. A request raised at the same (or older) level
        // than the running writer cannot cover new history; queueing it would
        // spawn a duplicate writer as soon as the current one settles.
        if (input.level !== undefined && existing.level !== undefined && input.level <= existing.level) {
          log.info("writer already covers this token level, skipping duplicate request", {
            sessionID: input.sessionID,
            level: input.level,
            runningLevel: existing.level,
          })
          return "skipped" as const
        }
        if (existing.pending) {
          log.info("writer pending evicted (newer range arrived)", { sessionID: input.sessionID })
        } else {
          log.info("writer already running, queueing", { sessionID: input.sessionID })
        }
        existing.pending = input
        return "queued" as const
      }
      writers.set(input.sessionID, state)

      // A writer whose record exists but which never hands off to the settle
      // watcher must still leave the map. One finalizer owns every refusal or
      // failure between entry and spawn: the pre-spawn drain re-check, a
      // child-session or spawn failure, and an interruption. FORK_DELTA: MiMo
      // writes the entry after the spawn
      // (repos/mimocode-v0.1.11/packages/opencode/src/session/checkpoint.ts:956)
      // and writes the watermark later inside the watcher (:976), so a refusal
      // between entry and spawn has no record to update there; here it does,
      // and this finalizer is what releases it.
      let writerChildSessionID: SessionID | undefined
      let spawned = false
      let handedOff = false

      const runWriter = Effect.fn("SessionCheckpoint.runWriter")(function* () {
      // Mirror parent runLoop's view (prompt.ts:2036-2040) so the writer's
      // ForkContext is byte-equal at the watermark moment. Reading the
      // unfiltered session stream would let computeBoundary land on a
      // subagent/prior-writer assistant turn and misalign the prefix cache.
      const sessionInfo = yield* session.get(input.sessionID)
      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID, {
        contextFrom: sessionInfo.contextFrom,
        contextWatermark: sessionInfo.contextWatermark,
        agentID: "main",
      })
      if (msgs.length === 0) {
        log.info("no messages, skipping checkpoint", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Compute boundary for last_checkpoint_message_id bookkeeping. Layer 6
      // (Task 16): role-aware adjustment to ensure tool_use/tool_result pairs
      // and same-message.id thinking blocks aren't split. OpenCode's ToolPart
      // carries both use (input) and result (output) on the SAME message, so
      // we project each ToolPart to both a tool_use and a tool_result block --
      // pairing is intrinsically satisfied today and the algorithm acts as a
      // no-op. Wiring is in place so future tool_result extraction
      // (separate user message) will walk the boundary correctly
      // without further changes here.
      const candidateID = computeBoundary(msgs)
      const candidateIdx = msgs.findIndex((m) => m.info.id === candidateID)
      const adjustedIdx = adjustBoundaryForApiInvariants(
        msgs.map((m) => ({
          role: m.info.role,
          id: m.info.id,
          content: m.parts.flatMap((p: MessageV2.Part) =>
            p.type === "tool"
              ? [
                  { type: "tool_use", id: (p as MessageV2.ToolPart).callID },
                  { type: "tool_result", tool_use_id: (p as MessageV2.ToolPart).callID },
                ]
              : [],
          ),
        })),
        Math.max(candidateIdx, 0),
      )
      const endMessageID = msgs[adjustedIdx]?.info.id ?? candidateID

      // v5 paths: single checkpoint.md per session, single memory.md per
      // project (carries across sessions in the same repo), task narrative
      // under <sid>/tasks/<id>/. Resolve projectID once HERE -- Instance.current
      // is ALS-bound and lost once the writer subagent fiber detaches.
      const projectID =
        (yield* Effect.try({
          try: () => Instance.current?.project?.id as ProjectID | undefined,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))) ?? ProjectID.global
      const sessMemDir = metaDir(input.sessionID)
      const projectMemDir = path.join(Global.Path.memory, "projects", projectID)
      const checkpointFile = checkpointPath(input.sessionID)
      const memoryFile = memoryPath(projectID)
      const taskMemDir = path.join(sessMemDir, "tasks")
      const notesFile = notesPath(input.sessionID)

      // Ensure dirs exist before writer fires
      yield* Effect.promise(() => fs.mkdir(sessMemDir, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(taskMemDir, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(projectMemDir, { recursive: true }))

      // Migrate legacy lowercase memory.md -> MEMORY.md before templating/reading.
      yield* Effect.promise(() => migrateProjectMemory(projectID))

      // Bootstrap checkpoint.md, memory.md, and notes.md from templates if missing.
      // Self-contained helpers also mkdir parent so they're safe in isolation.
      yield* Effect.promise(() => ensureCheckpointTemplate(checkpointFile))
      yield* Effect.promise(() => ensureMemoryTemplate(memoryFile))
      yield* Effect.promise(() => ensureNotesTemplate(notesFile))

      // Snapshot the checkpoint file before the writer runs. A writer turn can
      // report success without ever rewriting this file (the turn completed,
      // but the delta was not captured), so the settle watcher below advances
      // the watermark only when the file actually changed.
      const checkpointMtimeBefore = yield* Effect.promise(async () => {
        const file = Bun.file(checkpointFile)
        if (!(await file.exists())) return undefined
        return (await file.stat()).mtimeMs
      })

      // v5: single-file checkpoint, check if prior content exists
      const checkpointExists = yield* Effect.promise(() => Bun.file(checkpointFile).exists())
      const memoryExists = yield* Effect.promise(() => Bun.file(memoryFile).exists())
      const rangeDesc = checkpointExists
        ? [
            `Previous checkpoint: ${checkpointFile}`,
            memoryExists ? `Previous memory: ${memoryFile}` : "",
            "Read BOTH the prior checkpoint (to dedupe Discovered/Dead-end titles AND to carry forward Live Resources, Execution-context frames, and Session-metadata fields that are still alive) AND the prior memory (project memory) before writing yours.",
          ]
            .filter((s) => s.length > 0)
            .join("\n")
        : "This is the first checkpoint of this session. No prior checkpoint exists; MEMORY.md and the task narrative directory likely don't exist yet either."

      const progressDiff = yield* Effect.promise(() => buildProgressDiff(input.sessionID))
      const promptText = composeWriterPrompt({ checkpointFile, memoryFile, taskMemDir, notesFile, rangeDesc, progressDiff })

      // v6: spawn writer as subagent -- shared sessionID, automatic
      // SupervisorRegistryService registration, automatic tool whitelist enforcement
      // via permission system. Replaces the legacy session.create + manual
      // forkDetach + WriterState tracking that lived here pre-Task-27.
      //
      // Resolved via spawnRef rather than `yield* Supervisor.Service` to break the
      // (Supervisor -> SessionPrompt -> SessionCheckpoint -> Supervisor) layer cycle.
      const supervisor = spawnRef.current
      if (!supervisor) {
        log.warn("tryStartCheckpointWriter skipping — Supervisor service unavailable", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Axis B: branch forkContext shape on config.checkpoint.fork.
      // - true  -> preserve existing prefix-cache parent-fork behavior
      //          (parent agent's system + tools, full slice up to watermark).
      // - false -> cold-start: writer's own system + tools, delta slice since
      //          last_checkpoint_message_id (aligned past tool_use/tool_result).
      //
      // Previously the writer always forked
      // the parent's full prefix (effectively fork: true). The default is now
      // false (no-fork delta-only). Users on cache-breakpoint providers
      // (Anthropic) who want to retain the prefix-cache benefit must set
      // `checkpoint.fork: true` in their config.
      const cfg = yield* config.get()
      const forkMode = cfg.checkpoint?.fork ?? false

      const parentRow = yield* Effect.sync(() =>
        Database.use((d) =>
          d.select({ last: SessionTable.last_checkpoint_message_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get(),
        ),
      ).pipe(Effect.catch(() => Effect.succeed(undefined as { last: MessageID | null } | undefined)))
      const lastCheckpointMessageID = parentRow?.last ?? undefined

      // Hoisted watermark + delta computation: must run BEFORE session.create
      // so an empty-delta fork:false call short-circuits to "skipped" without
      // creating a child session or invoking supervisor.spawn. Pre-fix, the
      // empty-delta path fell through to spawn -> runLoop's
      // `isForkAgent && !forkCtx -> break` -> settle watcher resolved success ->
      // parent's last_checkpoint_message_id advanced silently (stale checkpoint).
      const watermarkIdx = msgs.findIndex((m) => m.info.id === endMessageID)
      if (watermarkIdx < 0) {
        log.warn("tryStartCheckpointWriter: watermark message not found, skipping", {
          sessionID: input.sessionID,
          endMessageID,
        })
        return "skipped" as const
      }

      // For fork:false only: precompute the aligned delta and bail if empty.
      // fork:true uses msgs.slice(0, watermarkIdx + 1) which is never empty
      // given msgs.length > 0 and watermarkIdx >= 0.
      const lastIdx = lastCheckpointMessageID
        ? msgs.findIndex((m) => m.info.id === lastCheckpointMessageID)
        : -1
      const rawDeltaStart = lastIdx >= 0 ? lastIdx + 1 : 0
      const alignedStart = alignToNonToolResultUser(
        msgs.map((m) => ({ info: { role: m.info.role }, parts: m.parts })),
        rawDeltaStart,
      )
      const delta = forkMode ? [] : msgs.slice(alignedStart, watermarkIdx + 1)
      if (!forkMode && delta.length === 0) {
        // Empty delta under fork:false signals either (a) a degenerate
        // session, or (b) a bug elsewhere advanced last_checkpoint_message_id
        // past the watermark. Either way, spawning a writer would be a
        // silent no-op that would still advance the watermark on settle --
        // skip visibly so it's observable in logs.
        log.warn("tryStartCheckpointWriter: empty delta under fork:false, skipping", {
          sessionID: input.sessionID,
          endMessageID,
          lastCheckpointMessageID,
        })
        return "skipped" as const
      }

      // Capture parent's view at the watermark for prefix-cache alignment.
      //
      // prefixCaptureRef is populated by SessionPrompt.layer to break the
      // (ToolRegistry -> SessionCheckpoint -> ToolRegistry) layer cycle.
      // When unset (parent's SessionPrompt.layer not mounted or already
      // finalized), buildLLMRequestPrefix cannot run and the resulting
      // forkCtx would be undefined. Spawning a writer with forkContext: undefined
      // still registers contextMode="full" on the supervisor, so the child
      // runLoop's "missing forkContext" guard fires and the writer is marked
      // failed. Skip instead -- the parent idle watcher / settle
      // re-trigger will retry once the parent's layer is mounted.
      const buildPrefix = prefixCaptureRef.current
      if (!buildPrefix) {
        log.warn("tryStartCheckpointWriter: prefixCaptureRef not set, skipping (parent SessionPrompt layer not mounted)", {
          sessionID: input.sessionID,
        })
        return "skipped" as const
      }
      const forkCtx: ForkContext | undefined = yield* (buildPrefix
        ? Effect.gen(function* () {
            const watermarkMsg = msgs[watermarkIdx]
            const parentAgentName = (watermarkMsg.info as { agent?: string }).agent
            // NOTE: parentAgentName guard is scoped to the forkMode:true branch only --
            // fork:false is agent-name-independent (always passes "checkpoint-writer"
            // to buildPrefix), so a missing parent agent field must not gate it.

            if (forkMode) {
              if (!parentAgentName) {
                log.warn(
                  "tryStartCheckpointWriter: watermark has no agent, fork:true requires parent agent — falling back to no forkContext",
                  { sessionID: input.sessionID, endMessageID },
                )
                return undefined as ForkContext | undefined
              }
              // fork:true -- preserve existing prefix-cache parent-fork behavior.
              // Build system + tools + inheritedMessages snapshot via capture ref
              // using the parent agent's identity and the full slice up to watermark.
              // The closure inside SessionPrompt.layer resolves Agent.Info and Provider.Model.
              const msgsAtWatermark = msgs.slice(0, watermarkIdx + 1)
              const prefix = yield* buildPrefix({
                sessionID: input.sessionID,
                agentName: parentAgentName,
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                msgs: msgsAtWatermark,
              })
              return {
                system: prefix.system,
                tools: prefix.tools,
                inheritedMessages: prefix.inheritedMessages,
                parentPermission: prefix.parentPermission,
                watermarkMsgID: endMessageID as MessageID,
                model: {
                  providerID: input.model.providerID as ProviderID,
                  modelID: input.model.modelID as ModelID,
                },
              } satisfies ForkContext
            }

            // fork:false -- cold-start: use the writer's own system + tools and
            // a delta slice since the last checkpoint. capture() resolves the
            // checkpoint-writer agent's own definition when agentName is
            // "checkpoint-writer", so a single call returns:
            //   - system + tools = writer's (because agentName === "checkpoint-writer"),
            //   - inheritedMessages = the delta we pass in, converted to ModelMessage[],
            //   - parentPermission = writer's own permission (used for tool-availability filter).
            // Earlier draft considered two buildPrefix calls (one with msgs:[] for
            // system+tools, one with msgs:delta for messages); rejected because
            // buildLLMRequestPrefix `Effect.die`s if msgs has no user message.
            // Delta is precomputed (and the empty-delta case is short-circuited)
            // above, before session.create.
            const writerPrefix = yield* buildPrefix({
              sessionID: input.sessionID,
              agentName: "checkpoint-writer",
              providerID: input.model.providerID,
              modelID: input.model.modelID,
              msgs: delta,
            })

            return {
              system: writerPrefix.system,
              tools: writerPrefix.tools,
              inheritedMessages: writerPrefix.inheritedMessages,
              parentPermission: writerPrefix.parentPermission,
              watermarkMsgID: endMessageID as MessageID,
              model: {
                providerID: input.model.providerID as ProviderID,
                modelID: input.model.modelID as ModelID,
              },
            } satisfies ForkContext
          })
        : Effect.succeed(undefined as ForkContext | undefined))

      // Axis A: writer always runs in a fresh child session. This isolates the
      // writer's messages and supervisor registration from the parent so:
      //   - parent's message table sees zero new rows,
      //   - parent's `sync.data.supervisor[parent]` does not include the writer,
      //   - Ctrl+X subagent cycle / SubagentFooter / DialogSubagent / etc. are
      //     all naturally clean (they all key on sessionID).
      // The writer's checkpoint.md / memory.md / progress paths are absolute and
      // computed from input.sessionID (parent) above, so file writes still target
      // the parent's artifacts. Settle watcher below also targets parent.
      const writerChildSession = yield* session.create({
        parentID: input.sessionID,
        title: `checkpoint-writer: ${rangeDesc}`,
      })
      writerChildSessionID = writerChildSession.id

      // Estimate delta tokens for observability. forkCtx.inheritedMessages is
      // ModelMessage[]; an exact count requires the tokenizer, but a rough
      // length heuristic is sufficient for the log line.
      const deltaApproxBytes = JSON.stringify(forkCtx?.inheritedMessages ?? []).length
      // G2c D1: the entry check above races a drain that begins while this
      // writer is between it and the spawn -- the child session and the delta
      // are already built by then. Re-check now, right before the billed spawn;
      // this refusal releases the entry (created at entry, before the build)
      // and the child session through the single refusal finalizer. No await
      // sits between this check and spawn, so the refusal is atomic.
      // Provenance: report section 10 D1, coordinator audit 2026-11-15.
      if (drainInProgress) {
        log.info("drain in progress, refusing to start a checkpoint writer", { sessionID: input.sessionID })
        return "skipped" as const
      }
      log.info("tryStartCheckpointWriter spawning", {
        sessionID: input.sessionID,
        childSessionID: writerChildSession.id,
        mode: forkMode ? "fork" : "no-fork",
        deltaApproxBytes,
        rangeDesc,
      })

      const result = yield* supervisor.spawn({
        mode: "subagent",
        sessionID: writerChildSession.id,
        // Axis A: writer runs under child session, but its checkpoint.md /
        // memory.md / progress paths AND CheckpointContext entries are keyed
        // on the PARENT. The splitover plugin reads these via supervisor.preStop
        // and must see parentSessionID to re-derive the right paths -- without
        // it, checkpointPath(child) returns an empty file and the plugin
        // emits a false topic-missing reflection that loops the writer up to
        // MAX_PRE_REACT.
        parentSessionID: input.sessionID,
        // The host above IS the writer's session: without this, spawnSubagent
        // nests a second child under it and the host stays an empty session
        // carrying only a "main" row, visible to the fleet dashboard and to
        // visibility.ts.
        ownsSession: true,
        agentType: "checkpoint-writer",
        description: `checkpoint writer for session ${input.sessionID} covering ${rangeDesc}`,
        task: promptText,
        context: "full",
        tools: ["read", "write", "edit", "apply_patch", "glob", "grep", "task"],
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        background: true,
        forkContext: forkCtx,
      }).pipe(
        // Set immediately after the billed spawn: from here the writer owns its
        // child session, and the refusal finalizer must never remove it.
        Effect.tap(() => Effect.sync(() => (spawned = true))),
        // The mark must not be skippable on an interrupt at the spawn
        // resumption, so one masked region covers the spawn and the mark.
        // G3-D1, reports/0.1.6/g3-one-writer-record.md:197
        Effect.uninterruptible,
      )

      const supervisorID = result.supervisorID

      // Capture priorTitles (from checkpoint.md as it stood at the watermark)
      // and register the per-supervisor context entry BEFORE the writer's first
      // turn so the splitover plugin's preStop hook can read it. The set
      // runs in microseconds; the writer's first LLM round-trip takes
      // seconds -- no race in practice.
      const priorTitles = yield* Effect.promise(() => loadPriorDiscoveredTitles(input.sessionID))
      CheckpointContext.set(input.sessionID, supervisorID, {
        priorTitles,
        expectedRevisions: [],
      })

      // Bookkeeping: the parent's last_checkpoint_message_id (the delta
      // watermark -- the point future rebuilds compute the message tail from)
      // advances ONLY when the writer SUCCEEDS. This is a transactional
      // invariant: the on-disk checkpoint content and the watermark move
      // together, or neither moves. If the writer failed/was cancelled (e.g.
      // `Aborted process` from worker teardown), advancing the watermark would
      // "consume" messages the failed checkpoint never actually captured --
      // silently dropping that span of context from every subsequent rebuild.
      // Leaving the watermark put means the next writer re-covers the same
      // delta, so nothing is lost. Fork into the layer's scope so the watcher
      // survives tryStartCheckpointWriter returning (background: true) but stays
      // tied to the layer's lifetime -- no orphan fiber on shutdown.
      //
      // Defensive: writers.set + spawn watcher is wrapped so a throw between
      // set and successful forkIn cleans the map (otherwise isWriterRunning
      // leaks "running" forever). Fork is multi-process:
      // CHECKPOINT_WRITER_TIMEOUT_MS bounds the writer Deferred.await at 10 min
      // so a hung cross-process writer cannot starve checkpointing or title
      // generation forever. The single-process version has no such timeout
      // (Effect.forkIn(scope) lets the scope interrupt the writer fiber);
      // without this timeout in fork mode, a dead cross-process writer would
      // otherwise hang isWriterRunning forever and block prune/fireCheckpoints.
      // Native setTimeout fallback handles writer Deferred leak; Effect.timeout
      // alone never fired because the Effect scheduler itself starved.
      const nativeTimer = setTimeout(() => {
        try {
          if (writers.get(input.sessionID) === state) {
            // Timeout outcome when checkpoint writer exceeds deadline
            Effect.runSync(Deferred.done(result.outcome, Exit.succeed({ status: "timeout" as const })))
          }
        } catch {}
      }, CHECKPOINT_WRITER_TIMEOUT_MS + 10_000)
      if (nativeTimer.unref) nativeTimer.unref()
      handedOff = true
      let settledOutcome: WriterOutcome = "failure"
      yield* Effect.gen(function* () {
        const outcome = yield* Deferred.await(result.outcome).pipe(
          Effect.timeout(CHECKPOINT_WRITER_TIMEOUT_MS),
          // Timeout outcome when waiting for checkpoint writer to complete
          Effect.orElseSucceed(() => ({ status: "timeout" as const })),
        )
        // The turn outcome is forwarded to the entry's `writing` Deferred. The
        // map entry is NOT replaced: waiters and the drain hold THIS state.
        yield* Deferred.done(state.writing, Exit.succeed(outcome)).pipe(Effect.ignore)
        yield* Effect.sync(() => clearTimeout(nativeTimer))
        if (outcome.status === "success") {
          // The supervisor outcome is a turn result, not a file-write
          // guarantee. Advancing the watermark without a fresh checkpoint.md
          // would make every later rebuild drop history the on-disk file never
          // captured. mtime is the cheapest proof the writer rewrote it; a
          // rewrite always advances mtime even when the content is unchanged.
          const written = yield* Effect.promise(async () => {
            const file = Bun.file(checkpointFile)
            if (!(await file.exists())) return false
            const mtime = (await file.stat()).mtimeMs
            return checkpointMtimeBefore === undefined || mtime > checkpointMtimeBefore
          })
          if (written) {
            yield* Effect.sync(() =>
              Database.use((d) =>
                d.update(SessionTable)
                  .set({ last_checkpoint_message_id: endMessageID as MessageID })
                  .where(eq(SessionTable.id, input.sessionID))
                  .run(),
              ),
            )
            settledOutcome = "success"
          } else {
            log.warn(
              "checkpoint writer succeeded without rewriting checkpoint.md — leaving watermark unchanged so the delta is re-covered",
              { sessionID: input.sessionID, endMessageID },
            )
            // The writer's turn succeeded; settlement stays success even when
            // the watermark did not move.
            settledOutcome = "success"
          }
        } else {
          settledOutcome = outcome.status === "timeout" ? "timeout" : "failure"
          if (outcome.status === "failure" && outcome.failure) state.failure = outcome.failure
          const failure = outcome.status === "failure" ? outcome.failure : undefined
          const classified = failure ? { kind: failure.kind, cause: failure.name } : {}
          if (failure && !failure.retryable) {
            log.warn(
              "checkpoint writer failed deterministically — this will recur at every threshold until the cause is fixed; leaving watermark unchanged so the delta is re-covered",
              { sessionID: input.sessionID, status: outcome.status, ...classified },
            )
          } else {
            log.warn("checkpoint writer did not succeed — leaving watermark unchanged so the delta is re-covered", {
              sessionID: input.sessionID,
              status: outcome.status,
              ...classified,
            })
          }
        }

        // Complete the public settlement ONLY after the mtime gate and the
        // watermark update, and before the map entry is deleted: a waiter that
        // observes it must be able to read the advanced boundary.
        yield* Deferred.succeed(state.settled, settledOutcome).pipe(Effect.ignore)

        // F40: capture pending before deleting the slot so a queued writer
        // (held while writer1 was running) can fire as a fresh writer.
        const pending = state.pending
        releaseWriter(input.sessionID, state, settledOutcome)

        // F44: aggregate writer slice tokens and emit cache-perf metric so
        // prefix-cache reuse is empirically observable. Degrades to zeros if
        // aggregation fails (e.g. session messages unavailable post-shutdown).
        const stats = yield* aggregateWriterCacheMetrics(session, input.sessionID, result.supervisorID).pipe(
          Effect.catch(() =>
            Effect.succeed({
              total_input_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              cache_hit_rate: 0,
              num_llm_calls: 0,
            }),
          ),
        )
        yield* bus
          .publish(WriterCachePerf, {
            sessionID: input.sessionID,
            writerSupervisorID: result.supervisorID,
            status: outcome.status === "success" ? ("completed" as const) : ("failed" as const),  // timeout and cancelled treated as failed
            ...stats,
          })
          .pipe(Effect.ignore)

        // F40: drain pending. If a queued request exists, fire a fresh writer
        // for it. Errors are swallowed -- the queued writer's failure should
        // not interrupt the original writer's settlement watcher.
        if (pending) {
          if (drainInProgress) {
            // The drain closed the writer slot: a fresh writer here would be
            // billed and killed when the process exits. The queued request is
            // dropped -- its delta is re-covered by the next writer.
            log.info("dropping pending writer, drain in progress", { sessionID: input.sessionID })
          } else {
            log.info("draining pending writer", { sessionID: input.sessionID })
            yield* tryStartCheckpointWriter(pending).pipe(Effect.ignore)
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => CheckpointContext.remove(input.sessionID, supervisorID)),
        ),
        // The map entry must go even when the watcher body fails: a leaked
        // entry keeps isWriterRunning true forever and makes every later
        // drain wait for the whole bound. Compare the state identity, like the
        // native timeout above, so a queued writer that already replaced the
        // entry is not deleted.
        Effect.ensuring(
          Effect.sync(() => releaseWriter(input.sessionID, state, settledOutcome)),
        ),
        // Registered last so it runs FIRST on the way out: an interruption
        // must still complete `writing` (a drain awaits it for the whole
        // writer bound) and `settled` with the known outcome, and always
        // before the entry is deleted.
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(state.writing, Effect.succeed({ status: "cancelled" } as AgentOutcome))
            Deferred.doneUnsafe(state.settled, Effect.succeed(settledOutcome))
          }),
        ),
        Effect.forkIn(scope),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // A fork failure or an interrupted watcher never reached the
            // ensures above; complete both Deferreds so the drain and waiters
            // are not stranded on their bounds.
            Deferred.doneUnsafe(state.writing, Effect.succeed({ status: "cancelled" } as AgentOutcome))
            Deferred.doneUnsafe(state.settled, Effect.succeed(settledOutcome))
            releaseWriter(input.sessionID, state, settledOutcome)
            CheckpointContext.remove(input.sessionID, supervisorID)
          }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
        ),
      )

      return "started" as const
      })

      const releaseOnRefusal = Effect.suspend(() => {
        if (handedOff) return Effect.void
        return Effect.gen(function* () {
          yield* Deferred.done(state.writing, Exit.succeed({ status: "cancelled" } as AgentOutcome)).pipe(Effect.ignore)
          const pending = state.pending
          // Complete the public settlement before the delete and before any
          // session cleanup: a defect there must not strand waiters on the
          // 300 s bound. `Effect.ignore` does not cover defects.
          yield* Deferred.succeed(state.settled, "failure" as const).pipe(Effect.ignore)
          releaseWriter(input.sessionID, state, "failure")
          // A spawned writer's session belongs to the supervisor; only the
          // pre-spawn child is ours to release. Removing a handed-off session
          // would kill the session of a live, billed writer.
          if (!spawned && writerChildSessionID !== undefined) {
            yield* session.remove(writerChildSessionID).pipe(Effect.ignore)
          }
          if (pending && !drainInProgress) {
            log.info("draining pending writer after a refusal", { sessionID: input.sessionID })
            yield* tryStartCheckpointWriter(pending).pipe(Effect.ignore)
          }
        })
      })
      return yield* runWriter().pipe(Effect.ensuring(releaseOnRefusal))
    // Effect.fn infers a generic signature; the Interface declares the concrete one.
    }) as (input: TryStartCheckpointWriterInput) => Effect.Effect<TryStartCheckpointWriterResult>

    const waitForWriterSettlement = Effect.fn("SessionCheckpoint.waitForWriterSettlement")(function* (
      sessionID: SessionID,
    ) {
      const state = writers.get(sessionID)
      // G3-D7, reports/0.1.6/g3-one-writer-record.md:214 -- a writer that
      // settled and left the map between its start and this lookup still
      // answers with what it settled to. Reading the record only when no live
      // entry exists keeps an in-flight writer authoritative.
      if (!state) return lastSettlements.get(sessionID) ?? { outcome: "no-writer" as const }

      // v2 writers manage 3 file types and frequently take 60-180s, so the
      // wait is bounded at 5min rather than left unbounded. WriterOutcome ->
      // Writer settlement: success -> "success", failure / cancelled ->
      // "failure", bound expired with the writer still unsettled -> "timeout".
      //
      // The bound expiring is NOT a writer failure -- the padding is not what
      // keeps the two apart, the distinct return value is. This timeout does
      // not cancel the writer, and the settle watcher that owns the watermark
      // advance (see tryStartCheckpointWriter) awaits the SAME Deferred with no
      // bound -- so a slow-but-successful writer still advances
      // last_checkpoint_message_id after we stop waiting. Reporting "failure"
      // here made a slow-but-working writer indistinguishable from a broken
      // one, which is why the two outcomes stay distinct. Callers must be able
      // to tell "still in flight" from "settled unsuccessfully": prune arms its
      // recovery gate on a settled TRANSIENT failure only, and "timeout" must
      // never reach that gate -- the writer may still be about to succeed.
      //
      // The entry is taken ONCE and awaited through its own `settled`, so a
      // later writer that replaces the map entry cannot change this answer.
      // FORK_DELTA: MiMo writes the entry after spawn
      // (repos/mimocode-v0.1.11/packages/opencode/src/session/checkpoint.ts:956)
      // and writes the watermark later inside the watcher (:976); here the
      // waiter settles after the settle step (mtime gate plus the watermark
      // update when the file was rewritten), and a success without a rewrite
      // deliberately keeps the watermark put.
      const outcome = yield* Deferred.await(state.settled).pipe(
        Effect.timeout(300_000),
        Effect.catch(() => Effect.succeed("timeout" as const)),
      )
      if (outcome === "timeout") {
        log.info("checkpoint writer wait bound expired — writer still in flight", {
          sessionID,
          boundMs: 300_000,
        })
        return { outcome: "timeout" as const }
      }
      if (outcome === "success") return { outcome: "success" as const }
      return state.failure ? { outcome: "failure" as const, failure: state.failure } : { outcome: "failure" as const }
    })

    // #1938's contract, unchanged: three flat values, "timeout" distinct from
    // "failure". Projected off waitForWriterSettlement rather than duplicated,
    // so the classification-aware caller and this one can never disagree.
    const waitForWriter: (sessionID: SessionID) => Effect.Effect<WriterOutcome | "no-writer"> = Effect.fn(
      "SessionCheckpoint.waitForWriter",
    )(function* (sessionID: SessionID) {
      return (yield* waitForWriterSettlement(sessionID)).outcome
    })

    const drainWriters = Effect.fn("SessionCheckpoint.drainWriters")(function* (input?: { timeoutMs?: number }) {
      const timeoutMs = input?.timeoutMs ?? CHECKPOINT_WRITER_TIMEOUT_MS
      // Close the writer slot for the whole drain: from here on no writer may
      // be spawned, registered or queued. The queued "draining pending
      // writer" path would otherwise register a fresh writer in the window
      // between the settle watcher's map delete and its re-insert -- the
      // drain would see an empty map, return, and the new writer would be
      // billed and killed without writing its checkpoint.
      drainInProgress = true
      const pending = [...writers.entries()]
      if (pending.length === 0) {
        // Nothing to await: the slot opens again at once. The empty drain
        // stays instant on purpose -- a slower one keeps the process alive
        // past a failed prompt and the CLI then emits the error record
        // twice (packages/opencode/test/cli/run/run-process.test.ts, "--format
        // json emits a pure error record for a rejected prompt request").
        drainInProgress = false
        return { drained: 0, timedOut: 0 }
      }
      log.info("draining checkpoint writers before shutdown", {
        count: pending.length,
        timeoutMs,
      })

      // The drain ends when the writers map is empty, not when the writers
      // that were in the map when it started have settled. A writer that
      // starts after the drain began -- the queued "draining pending writer"
      // path fires a fresh writer the moment the running one leaves the map --
      // would otherwise still be running when the process exits: its LLM
      // round-trip is billed, the checkpoint file is not written and the delta
      // watermark does not advance, so the next writer covers the same delta
      // again.
      //
      // The map is polled instead of snapshotted, and the drain only ends once
      // the map has stayed empty for a short quiescence window, so a writer
      // that registers right after the awaited one left the map is awaited
      // too. Provenance: G2b lab runs
      // (build-worktrees/tmp/g2b-step1-findings.md section 3) measured 10/10
      // discarded writer runs dying exactly at the drain's 60 s bound and none
      // of them starting late: the bound, not the snapshot, was the measured
      // cause of those discards. The bound is now the writer's own timeout
      // (CHECKPOINT_WRITER_TIMEOUT_MS), so an in-flight writer is awaited until
      // it settles.
      const POLL = "20 millis"
      const QUIET_POLLS = 5
      yield* Effect.gen(function* () {
        let quiet = 0
        while (true) {
          const entries = [...writers.entries()]
          if (entries.length === 0) {
            quiet += 1
            if (quiet >= QUIET_POLLS) break
            yield* Effect.sleep(POLL)
            continue
          }
          quiet = 0
          // Deferred.await ignores fiber interruption during shutdown because
          // it resolves via Deferred.succeed in the detached writer. We only
          // need a collective upper bound so a stuck writer doesn't block exit.
          yield* Effect.all(
            entries.map(([, state]) => Deferred.await(state.writing)),
            { concurrency: "unbounded" },
          )
          // The outcome resolves before the writer's watcher has advanced the
          // watermark and removed the entry from the map. Returning here would
          // let the process exit with the watermark unmoved, and the next writer
          // would cover the same delta again. Wait for the entries to clear.
          yield* Effect.sleep(POLL)
        }
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.catch(() => Effect.succeed(undefined)),
        // The slot opens again when the drain is over, whatever ended it: the
        // map emptied, the bound expired, the effect failed or was interrupted.
        Effect.ensuring(
          Effect.sync(() => {
            drainInProgress = false
          }),
        ),
      )

      // Writers delete themselves from the map on success/failure, so anything
      // still present after the timeout is a writer that didn't settle in time.
      const timedOut = pending.filter(([sessionID]) => writers.has(sessionID)).length
      const drained = pending.length - timedOut
      if (timedOut > 0) log.warn("drain timed out, writers still pending", { drained, timedOut })
      else log.info("drain complete", { drained })
      return { drained, timedOut }
    })

    const hasCheckpoint = Effect.fn("SessionCheckpoint.hasCheckpoint")(function* (sessionID: SessionID) {
      return yield* Effect.promise(() => Bun.file(checkpointPath(sessionID)).exists())
    })

    const hasMemoryOrTasks = Effect.fn("SessionCheckpoint.hasMemoryOrTasks")(function* (sessionID: SessionID) {
      const memoryRoot = yield* memory.root()
      const sessMemDir = path.join(memoryRoot, "sessions", sessionID)
      const memEntries = yield* Effect.promise(() =>
        fs.readdir(sessMemDir).catch(() => [] as string[]),
      )
      if (memEntries.length > 0) return true
      const tasks = yield* taskRegistry.list({ session_id: sessionID, include_terminal: true })
      return tasks.length > 0
    })

    const loadLatest = Effect.fn("SessionCheckpoint.loadLatest")(function* (sessionID: SessionID) {
      const content = yield* Effect.promise(() =>
        Bun.file(checkpointPath(sessionID)).text().catch(() => ""),
      )
      return content || undefined
    })

    const loadCheckpoints = Effect.fn("SessionCheckpoint.loadCheckpoints")(function* (
      sessionID: SessionID,
      _count: number,
    ) {
      const content = yield* Effect.promise(() =>
        Bun.file(checkpointPath(sessionID)).text().catch(() => ""),
      )
      return content ? [content] : []
    })

    const renderIndex = Effect.fn("SessionCheckpoint.renderIndex")(function* (sessionID: SessionID) {
      const snapFile = checkpointPath(sessionID)
      const exists = yield* Effect.promise(() => Bun.file(snapFile).exists())
      if (!exists) return "No checkpoints yet for this session."

      const content = yield* Effect.promise(() => Bun.file(snapFile).text().catch(() => ""))
      const topicMatch = content.match(/^Topic:\s*(.+)$/m)
      const topic = topicMatch ? topicMatch[1].trim() : "(unknown)"

      const dir = metaDir(sessionID)
      const lines: string[] = []
      lines.push("## Checkpoint")
      lines.push("")
      lines.push(`Directory: ${dir}/`)
      lines.push("")
      lines.push(`Current checkpoint (${topic}): checkpoint.md [shown below]`)
      lines.push("")
      lines.push(`Use read("${snapFile}") to access the full checkpoint.`)

      return lines.join("\n")
    })

    const renderRebuildContext = Effect.fn("SessionCheckpoint.renderRebuildContext")(function* (
      sessionID: SessionID,
      opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string; skipWriterWait?: boolean },
    ) {
      // renderRebuildContext is for the user-facing main agent's context rebuild.
      // Subagent-mode supervisors (system-spawned writers, model-spawned subagents)
      // share the parent's session but don't have their own checkpoint state to
      // render -- return empty so the rebuild path is a no-op for them.
      // Note: agentID === "main" must pass through. After F49+F50 the main
      // agent's lastUser.agentID is "main" (DB row->info reconstruction in
      // message-v2.ts populates info.agentID from agent_id column), and the
      // runLoop calls this with that value. Treating "main" as subagent here
      // would skip rebuild -> fall through to F39 compaction -> context loss.
      if (opts?.agentID && opts.agentID !== "main") return ""

      const inFlight = writers.get(sessionID)
      if (inFlight && !opts?.skipWriterWait) {
        log.info("rebuild waiting for in-flight writer", { sessionID })
        // Await the settled record, not the bare turn outcome: the rebuild must
        // read the checkpoint state only after the settle step (mtime gate plus
        // the watermark update when the file was rewritten). A success without
        // a rewrite deliberately keeps the watermark put.
        // FORK_DELTA: MiMo writes the entry after spawn
        // (repos/mimocode-v0.1.11/packages/opencode/src/session/checkpoint.ts:956)
        // and updates the watermark inside the watcher (:976); here the entry's
        // `settled` completes after that settle step.
        yield* Effect.race(
          Deferred.await(inFlight.settled).pipe(Effect.as("done" as const)),
          Effect.sleep("60 seconds").pipe(
            Effect.tap(() => Effect.sync(() => log.warn("writer wait timeout — using on-disk checkpoint", { sessionID }))),
            Effect.as("timeout" as const),
          ),
        ).pipe(Effect.catch(() => Effect.succeed("error" as const)))
      }

      const cfg = yield* config.get()
      const caps = cfg.checkpoint?.push_caps ?? {}
      const memoryRoot = yield* memory.root()

      const sessMemDir = path.join(memoryRoot, "sessions", sessionID)

      // Resolve current project ID once. Used by Section 7 (project memory
      // read) and Section 8 (FTS scope filter). ALS-bound -- must be resolved
      // before any deferred work.
      const currentProjectID = yield* Effect.try({
        try: () => Instance.current?.project?.id as ProjectID | undefined,
        catch: () => undefined as ProjectID | undefined,
      }).pipe(Effect.catch(() => Effect.succeed<ProjectID | undefined>(undefined)))
      const projectID = currentProjectID ?? ProjectID.global

      // Section data: tasks (SQL), session checkpoint (file), project memory (file).
      const tasks = yield* taskRegistry.list({ session_id: sessionID, include_terminal: true })

      const checkpointResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(checkpointPath(sessionID), caps.checkpoint ?? 11_000),
      )
      const checkpointText = checkpointResult?.text ?? ""

      yield* Effect.promise(() => migrateProjectMemory(projectID))
      const memoryResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(memoryPath(projectID), caps.memory ?? 10_000),
      )
      const memoryText = memoryResult?.text ?? ""

      const notesResult = yield* Effect.promise(() =>
        readBudgeted(notesPath(sessionID), caps.notes ?? 6000),
      )
      const notesText = notesResult?.text ?? ""

      const globalResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(globalMemoryPath(), caps.global ?? 6000),
      )
      const globalText = globalResult?.text ?? ""

      const supervisors = yield* supervisorRegistry.listActive()

      // Pull recent user messages (verbatim, FIFO-bounded). Done before the
      // early-bail check so a session whose only signal is "user typed N
      // prompts" still emits the section.
      const recentUserCap = caps.recent_user ?? 16_000
      const recentUserPerMsg = caps.recent_user_per_msg ?? 2_000
      const recentUserEntries: string[] = []
      if (recentUserCap > 0) {
        // Fixed page ceiling sized comfortably above the token budget: at the
        // 2K per-msg cap, 200 msgs ~ 400K tokens, far past any recent_user cap,
        // so the token loop below -- not this limit -- is what bounds the section.
        // The only way 200 msgs could underflow the budget is hundreds of sub-
        // 80-token prompts ("ok"/"continue"), which carry no anchors worth
        // paging deeper for. Keeping a constant avoids a magic tokens/msg
        // heuristic and a larger fetch+hydrate on every checkpoint.
        // Exclude rebuild/compaction boundary messages: insertRebuildBoundary
        // writes a role:"user" row carrying a checkpoint part + synthetic text
        // holding the *previous* rebuild context. Re-ingesting it would fold
        // each prior rebuild back in recursively (fractal bloat). userMsgText
        // also drops synthetic text parts as a second guard.
        const userMsgs = MessageV2.page({ sessionID, agentID: "main", limit: 200 }).items.filter(
          (m) =>
            m.info.role === "user" &&
            !m.parts.some((p) => p.type === "tool" || p.type === "checkpoint" || p.type === "compaction"),
        )
        // Iterate most-recent backward so FIFO drops oldest when total cap hits.
        let remaining = recentUserCap
        for (let i = userMsgs.length - 1; i >= 0; i--) {
          const rawText = userMsgText(userMsgs[i].parts)
          if (!rawText.trim()) continue
          const entry = truncateVerbatimUserMsg(rawText, recentUserPerMsg, userMsgs[i].info.id)
          const cost = Token.estimate(entry)
          if (remaining - cost < 0) break
          recentUserEntries.unshift(entry)
          remaining -= cost
        }
      }

      // Bail early if absolutely nothing to push: no tasks, no memory content, no live supervisors,
      // no user messages.
      if (
        tasks.length === 0 &&
        !checkpointText.trim() &&
        !memoryText.trim() &&
        !globalText.trim() &&
        supervisors.length === 0 &&
        recentUserEntries.length === 0
      ) {
        return ""
      }

      const lines: string[] = []

      // F17: Explicit "already loaded" header. Anchors the active recall
      // protocol's "look for this header" instruction in buildMemoryInstructions.
      lines.push(
        "The following blocks are auto-loaded from your session memory. They are already in your context — do not Read them as whole files. Use Grep for specific facts instead.",
      )
      lines.push("")

      // Section 3: tasks ledger (hierarchical with subtasks).
      lines.push("## Tasks ledger")
      if (tasks.length === 0) {
        lines.push("(none)")
      } else {
        const topLevel = tasks.filter((t) => !t.parent_task_id)
        const byParent = new Map<string, typeof tasks>()
        for (const t of tasks) {
          if (!t.parent_task_id) continue
          const bucket = byParent.get(t.parent_task_id) ?? []
          bucket.push(t)
          byParent.set(t.parent_task_id, bucket)
        }
        const statusIcon = (s: string) =>
          ({ open: "\uD83D\uDD35", in_progress: "\uD83D\uDD04", blocked: "\uD83D\uDFE1", done: "\u2705", abandoned: "\u274C" })[s] ?? s
        const ledgerLines: string[] = []
        for (const t of topLevel) {
          ledgerLines.push(`- ${t.id} ${t.status} — ${t.summary}`)
          const subs = byParent.get(t.id) ?? []
          if (subs.length === 0) continue
          const sublist = subs
            .map((s) => `${statusIcon(s.status)}\u200B${s.id}`)
            .join(" / ")
          ledgerLines.push(`  Subtasks: ${sublist}`)
        }
        lines.push(truncate(ledgerLines.join("\n"), caps.tasks_ledger ?? 2000))
      }
      lines.push("")

      // Section 5: session checkpoint (full body, capped).
      if (checkpointText.trim()) {
        lines.push("## Session checkpoint")
        lines.push(checkpointText.trim())
        lines.push("")
      }

      // Section 6: active supervisors ledger (one line per running supervisor).
      if (supervisors.length > 0) {
        lines.push("## Active supervisors")
        let supervisorBudget = caps.supervisor_ledger ?? 500
        for (const a of supervisors) {
          const line = `- ${a.supervisorID} — ${a.status}, "${a.description}" (agent=${a.agent})`
          const cost = Token.estimate(line)
          if (supervisorBudget - cost < 0) break
          lines.push(line)
          supervisorBudget -= cost
        }
        lines.push("")
      }

      // Section 6.5: recent user input (verbatim, FIFO, budget-bounded).
      // Preserves original user prose from the live DB -- writer summaries
      // paraphrase user commands, losing anchors like exact flags or pasted
      // content. (entries computed earlier so the early-bail guard sees them.)
      if (recentUserEntries.length > 0) {
        lines.push("## Recent user input (verbatim)")
        lines.push(...recentUserEntries)
        lines.push("")
      }

      // Section 7: project memory (full body, capped).
      if (memoryText.trim()) {
        lines.push("## Project memory")
        lines.push(memoryText.trim())
        lines.push("")
      }

      // Section 7.4: global memory (full body, capped). User-level cross-project
      // preferences. Placed after project memory (more actionable) and before
      // session notes (more volatile).
      if (globalText.trim()) {
        lines.push("## Global memory")
        lines.push(globalText.trim())
        lines.push("")
      }

      // F14 Section 7.5: session notes (full body, capped). Skip if empty.
      if (notesText.trim()) {
        lines.push("## Session notes")
        lines.push(notesText.trim())
        lines.push("")
      }

      // Section 8: memory keys index (paths only, omit already-pushed).
      // SQL-scoped to the current session/project + global so other
      // sessions' files are not leaked. Falls back to skipping the projects
      // scope when the current project is the global/non-git fallback.
      // Reconcile first so files written off-tool (e.g. by the checkpoint
      // writer subagent) are visible in the FTS index here.
      yield* memory.reconcile().pipe(Effect.ignore)
      const pushedPaths = new Set(
        [
          memoryPath(projectID),
          checkpointPath(sessionID),
          globalMemoryPath(),
        ].filter((p) => p.length > 0),
      )

      const scopeFilter =
        currentProjectID && currentProjectID !== ProjectID.global
          ? or(
              eq(MemoryFtsTable.scope, "global"),
              and(eq(MemoryFtsTable.scope, "sessions"), eq(MemoryFtsTable.scope_id, sessionID as string)),
              and(eq(MemoryFtsTable.scope, "projects"), eq(MemoryFtsTable.scope_id, currentProjectID)),
            )
          : or(
              eq(MemoryFtsTable.scope, "global"),
              and(eq(MemoryFtsTable.scope, "sessions"), eq(MemoryFtsTable.scope_id, sessionID as string)),
            )
      const scopedPaths = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select({ path: MemoryFtsTable.path }).from(MemoryFtsTable).where(scopeFilter).all(),
        ),
      )
      const keyEntries = scopedPaths
        .map((r) => r.path)
        .filter((p) => !pushedPaths.has(p) && !p.includes(`${path.sep}checkpoint${path.sep}learning-`))
        .map((p) => p.replace(memoryRoot + path.sep, ""))
      if (keyEntries.length > 0) {
        lines.push("## Memory keys index")
        let kBudget = caps.memory_titles ?? 500
        for (const entry of keyEntries) {
          const cost = Token.estimate(entry)
          if (kBudget - cost < 0) break
          lines.push(`- ${entry}`)
          kBudget -= cost
        }
        lines.push("")
      }

      // Section 10: explicit seam framing for LLM continuity post-rebuild.
      // Compaction-summary pattern: tells the model
      // that preserved messages below are real history, not pseudo-content,
      // so it resumes mid-loop instead of asking "what would you like me
      // to do".
      lines.push("")
      lines.push(
        "This session is being continued from a previous conversation that hit a checkpoint. The session checkpoint and project memory above cover the earlier portion of the conversation.",
      )
      lines.push("")
      lines.push(
        "Recent messages are preserved verbatim below — the assistant turn (and any tool results) you'll see is real history, not pseudo-content. Continue your task by responding to the most recent state.",
      )
      lines.push("")
      lines.push(
        "Resume directly. Do not acknowledge this memory dump, do not recap, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.",
      )

      // Section 11: tail-aware system reminder. Picks the appropriate nudge
      // based on how the preserved tail ends: tool-calls -> continue loop,
      // stop -> check task spec before stopping again, tool -> process results,
      // user -> no addendum needed.
      const info = opts?.lastMessageInfo
      if (info) {
        const reminder = (() => {
          switch (info.role) {
            case "assistant":
              if (info.finish === "tool-calls") return autonomousLoopReminder()
              return stopReminder(undefined)
            case "tool":
              return toolResultContinueReminder()
            case "user":
              return ""
          }
        })()
        if (reminder) {
          lines.push("")
          lines.push(reminder)
        }
      }

      return lines.join("\n")
    // Effect.fn infers a generic signature; the Interface declares the concrete one.
    }) as (sessionID: SessionID, opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string }) => Effect.Effect<string>

    const lastBoundary = Effect.fn("SessionCheckpoint.lastBoundary")(function* (sessionID: SessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select({ last_checkpoint_message_id: SessionTable.last_checkpoint_message_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ),
      )
      return row?.last_checkpoint_message_id as MessageID | undefined
    })

    const isWriterRunning = Effect.fn("SessionCheckpoint.isWriterRunning")(function* (sessionID: SessionID) {
      return writers.has(sessionID)
    })

    // idle-trigger -- additive second path, reuses same writer &
    // CHECKPOINT_WRITER_TIMEOUT_MS handling (3a3a110e50) without modifying it.
    // Fires only when session has
    // meaningful content (>=3 user turns OR >=2 tool calls). Debounced, guarded
    // against system-spawned / writer-running / memory-disabled, and against
    // empty delta (fork:false already bails on empty delta inside tryStart).
    const maybeCheckpointOnIdle = Effect.fn("SessionCheckpoint.maybeCheckpointOnIdle")(function* (
      sessionID: SessionID,
    ) {
      const now = Date.now()
      const last = idleLastTrigger.get(sessionID) ?? 0
      if (now - last < IDLE_DEBOUNCE_MS) {
        log.info("idle checkpoint debounced", { sessionID, sinceMs: now - last })
        return "skipped" as const
      }
      if (!isMemoryWriteEnabled(yield* config.get())) {
        log.info("idle checkpoint skipped — memory writing disabled", { sessionID })
        return "skipped" as const
      }
      if (writers.has(sessionID)) {
        log.info("idle checkpoint skipped — writer already running", { sessionID })
        return "skipped" as const
      }
      if (yield* isCheckpointWriterSession(sessionID)) {
        log.info("idle checkpoint skipped — checkpoint-writer session", { sessionID })
        return "skipped" as const
      }
      // Fetch main slice; use the same filtered view the writer uses so counts match.
      const sessionInfo = yield* session.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined as Session.Info | undefined)))
      if (!sessionInfo) {
        log.info("idle checkpoint skipped — session not found", { sessionID })
        return "skipped" as const
      }
      const msgs = yield* MessageV2.filterCompactedEffect(sessionID, {
        contextFrom: sessionInfo.contextFrom,
        contextWatermark: sessionInfo.contextWatermark,
        agentID: "main",
      }).pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
      if (msgs.length === 0) {
        log.info("idle checkpoint skipped — no messages", { sessionID })
        return "skipped" as const
      }
      const signals = countIdleSignals(msgs)
      if (!isIdleCheckpointEligible(signals)) {
        log.info("idle checkpoint skipped — below meaningful threshold", {
          sessionID,
          ...signals,
          thresholds: IDLE_TRIGGER_CONFIG,
        })
        return "skipped" as const
      }
      // If a checkpoint already exists, only fire when there's new meaningful
      // delta since lastCheckpointMessageID. Prevents re-checkpointing the
      // same short session on every idle flap after the first success.
      const lastCheckpointID = yield* Effect.sync(() =>
        Database.use((d) =>
          d.select({ last: SessionTable.last_checkpoint_message_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ),
      ).pipe(
        Effect.map((r) => r?.last as MessageID | undefined),
        Effect.catch(() => Effect.succeed(undefined as MessageID | undefined)),
      )
      if (lastCheckpointID) {
        const lastIdx = msgs.findIndex((m) => m.info.id === lastCheckpointID)
        const rawStart = lastIdx >= 0 ? lastIdx + 1 : 0
        const alignedStart = alignToNonToolResultUser(
          msgs.map((m) => ({ info: { role: m.info.role }, parts: m.parts })),
          rawStart,
        )
        const delta = msgs.slice(alignedStart)
        const deltaSignals = countIdleSignals(delta)
        if (!isIdleCheckpointEligible(deltaSignals)) {
          log.info("idle checkpoint skipped — delta below threshold", {
            sessionID,
            deltaUserTurns: deltaSignals.userTurns,
            deltaToolCalls: deltaSignals.toolCalls,
          })
          return "skipped" as const
        }
      }
      // Resolve model for the writer subagent:
      // 1. Last assistant message's model (most faithful to session's active model)
      // 2. Config's default model fallback
      // 3. Skip if none resolvable -- writer spawn would fail anyway.
      let model: { providerID: string; modelID: string } | undefined
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        // Assistant info carries providerID/modelID directly; user info carries them under model.
        if (m.info.role === "assistant") {
          const assistantInfo = m.info as MessageV2.Assistant
          if (assistantInfo.providerID && assistantInfo.modelID) {
            model = { providerID: assistantInfo.providerID, modelID: assistantInfo.modelID }
            break
          }
        }
        // Also check via `model` object shape (User stores model.providerID)
        const userInfo = m.info as MessageV2.User
        const prov = userInfo.model?.providerID
        const mid = userInfo.model?.modelID
        if (prov && mid) {
          model = { providerID: prov, modelID: mid }
          break
        }
      }
      if (!model) {
        // Fallback: try config checkpoint model or any configured default
        // The config's checkpoint.model and model fields are read as a plain record here.
        const cfg = (yield* config.get().pipe(Effect.catch(() => Effect.succeed({})))) as Record<string, unknown>
        const checkpointCfg = cfg.checkpoint && typeof cfg.checkpoint === "object" ? (cfg.checkpoint as Record<string, unknown>) : undefined
        const cfgModel = checkpointCfg?.model ?? cfg.model
        if (typeof cfgModel === "string" && cfgModel.includes("/")) {
          const [p, m] = cfgModel.split("/")
          model = { providerID: p, modelID: m }
        } else if (cfgModel && typeof cfgModel === "object") {
          const cfgObj = cfgModel as Record<string, unknown>
          if (cfgObj.providerID && cfgObj.modelID) {
            model = { providerID: cfgObj.providerID as string, modelID: cfgObj.modelID as string }
          }
        }
      }
      if (!model) {
        log.info("idle checkpoint skipped — no model resolvable", { sessionID, signals })
        return "skipped" as const
      }
      // Minimal promptOps for the idle path -- checkpoint.ts only stores it for
      // pending queue, never invokes it. Provide no-op stub so tryStart can
      // proceed without pulling in the full SessionPrompt layer.
      const idlePromptOps: SupervisorPromptOps = {
        cancel: () => {},
        resolvePromptParts: (template: string) => Effect.succeed([]),
        prompt: (input: unknown) => Effect.succeed({}),
      }
      idleLastTrigger.set(sessionID, now)
      log.info("idle checkpoint firing", { sessionID, model, signals })
      return yield* tryStartCheckpointWriter({
        sessionID,
        model,
        promptOps: idlePromptOps,
      })
    })

    const insertRebuildBoundary = Effect.fn("SessionCheckpoint.insertRebuildBoundary")(function* (input: {
      sessionID: SessionID
      boundary: MessageID
      lastMessageInfo?: LastMessageInfo
      agentID?: string
      agent: string
      model: { providerID: string; modelID: string }
      boundaryCreatedAt?: number
    }) {
      const rebuildContext = yield* renderRebuildContext(input.sessionID, {
        lastMessageInfo: input.lastMessageInfo,
        agentID: input.agentID,
      }).pipe(Effect.catch(() => Effect.succeed("")))
      if (!rebuildContext) return false

      const indexText = yield* renderIndex(input.sessionID).pipe(Effect.catch(() => Effect.succeed("")))

      // Resolve the boundary time before inserting. The caller may pass an
      // undefined time when the boundary message left its filterCompacted
      // slice, so the authoritative DB lookup is the live fallback. Fail
      // closed only when BOTH are unknown: the old Date.now() fallback placed
      // the boundary after the tail (upstream's broken placement) and swallowed
      // the messages the rebuild must keep.
      // I2-D2, reports/0.1.6/i2-b1-rebuild-boundary.md:209
      const allMsgs = yield* session.messages({ sessionID: input.sessionID, agentID: "*" })
      const boundaryTime =
        input.boundaryCreatedAt ??
        allMsgs.find((m) => m.info.id === input.boundary)?.info.time.created
      if (boundaryTime === undefined) {
        log.warn("rebuild boundary skipped: no boundary timestamp available", {
          sessionID: input.sessionID,
          boundary: input.boundary,
        })
        return false
      }
      const syntheticTime = boundaryTime + 1
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        model: { providerID: input.model.providerID as ProviderID, modelID: input.model.modelID as ModelID },
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: syntheticTime },
      })

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "checkpoint",
        checkpointDir: "",
        checkpointNumber: 0,
        coveredUpTo: input.boundary,
      })

      if (indexText) {
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: indexText,
        })
      }

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: rebuildContext,
      })

      const supervisorsText = yield* supervisorRegistry
        .renderForAgent(input.sessionID)
        .pipe(Effect.catch(() => Effect.succeed("")))
      if (supervisorsText) {
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: supervisorsText,
        })
      }

      // Microcompact: messages strictly newer than the boundary will survive
      // into the rebuild context. Clear tool_result content for compactable
      // tools so the first uncached request after rebuild is smaller. tool_use
      // is preserved -- LLM still sees what action was taken; result body
      // becomes "[Old tool result content cleared]" via the converter at
      // message-v2.ts (ToolStateCompleted -> output).
      //
      // boundaryTime was resolved above (explicit time, else the full-DB
      // lookup) and the insert already failed closed when both were unknown.
      // Never fall back to 0 here: that would clear EVERY completed
      // compactable tool result in the entire session.
      let cleared = 0
      let bytes = 0
      for (const m of allMsgs) {
        if (m.info.id === msg.id) continue
        if (m.info.time.created <= boundaryTime) continue
        for (const part of m.parts) {
          if (part.type !== "tool") continue
          if (!COMPACTABLE_TOOL_NAMES.has(part.tool)) continue
          if (part.state.status !== "completed") continue
          if (part.state.time.compacted) continue
          bytes += Buffer.byteLength(part.state.output)
          part.state.time.compacted = Date.now()
          yield* session.updatePart(part)
          cleared += 1
        }
      }
      if (cleared > 0) {
        log.info("rebuild microcompact", { sessionID: input.sessionID, parts: cleared, bytes })
      }

      return true
    // Effect.fn infers a generic signature; the Interface declares the concrete one.
    }) as (input: { sessionID: SessionID; boundary: MessageID; lastMessageInfo?: LastMessageInfo; agentID?: string; agent: string; model: { providerID: string; modelID: string }; boundaryCreatedAt?: number }) => Effect.Effect<boolean>

    // subscribe to SessionStatus.Idle -- fire additive checkpoint on idle.
    // Uses the same writer path and therefore the same CHECKPOINT_WRITER_TIMEOUT_MS
    // native-timer fallback from 3a3a110e50 (more invocations = more live-fire
    // observation of that fix). The callback re-enters Effect via Effect.runFork
    // so it never blocks the status publish. Bus `on()` preserves ALS via
    // InstanceState.bind, but the forked fiber still needs InstanceRef provision
    // because Effect.runFork does not inherit FiberRefs. Capture at Layer build time.
    const idleInstanceCtx = yield* Effect.gen(function* () {
      const ref = yield* InstanceRef
      if (ref) return ref
      try {
        return Instance.current
      } catch (e) {
        if (e instanceof LocalContext.NotFound) return undefined
        throw e
      }
    })
    const idleWorkspaceCtx = yield* Effect.gen(function* () {
      const ref = yield* WorkspaceRef
      if (ref !== undefined) return ref
      try {
        return WorkspaceContext.workspaceID
      } catch (e) {
        if (e instanceof LocalContext.NotFound) return undefined
        throw e
      }
    })
    yield* bus
      .subscribeCallback(
        SessionStatus.Event.Idle,
        InstanceState.bind((event: { properties: { sessionID: SessionID } }) => {
          const sid = event.properties.sessionID
          let effect: Effect.Effect<void> = maybeCheckpointOnIdle(sid).pipe(
            Effect.catch((e: unknown) => Effect.sync(() => log.warn("idle checkpoint error", { sessionID: sid, error: String(e) }))),
            Effect.ignore,
          ) as Effect.Effect<void>
          if (idleInstanceCtx) effect = effect.pipe(Effect.provideService(InstanceRef, idleInstanceCtx))
          if (idleWorkspaceCtx !== undefined) effect = effect.pipe(Effect.provideService(WorkspaceRef, idleWorkspaceCtx))
          const run = () => Effect.runFork(effect)
          if (idleInstanceCtx) Instance.restore(idleInstanceCtx, run)
          else run()
        }),
      )
      .pipe(Effect.ignore)

    return Service.of({
      tryStartCheckpointWriter,
      waitForWriter,
      waitForWriterSettlement,
      drainWriters,
      hasCheckpoint,
      hasMemoryOrTasks,
      loadLatest,
      loadCheckpoints,
      renderIndex,
      renderRebuildContext,
      lastBoundary,
      isWriterRunning,
      maybeCheckpointOnIdle,
      insertRebuildBoundary,
    })
  }),
)

// ---------------------------------------------------------------------------
// Default layer
// ---------------------------------------------------------------------------

// `defaultLayer` no longer requires `Supervisor.Service`: SessionCheckpoint reaches
// the Supervisor implementation through the late-bound `spawnRef` (see
// `supervisor/spawn-ref.ts`). This deliberately breaks the otherwise-unresolvable
// layer cycle Supervisor -> SessionPrompt -> SessionCheckpoint -> Supervisor. The AppLayer
// constructs `Supervisor.defaultLayer` separately; its initialiser populates
// `spawnRef`, which `tryStartCheckpointWriter` reads at call time.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Memory.layer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(SupervisorRegistryService.defaultLayer),
    Layer.provide(DatabaseModule.layerFromPath(DatabaseModule.path())),
  ),
)

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

// Layer.suspend infers a narrower Service binding than makeRuntime's layer parameter declares.
const { runPromise } = makeRuntime(Service, defaultLayer as unknown as Layer.Layer<Service, unknown>)

export async function hasCheckpoint(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.hasCheckpoint(input.sessionID))
}

export async function loadLatest(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.loadLatest(input.sessionID))
}

export async function loadCheckpoints(input: { sessionID: SessionID; count: number }) {
  return runPromise((svc) => svc.loadCheckpoints(input.sessionID, input.count))
}

export async function renderIndex(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.renderIndex(input.sessionID))
}

export async function renderRebuildContext(input: {
  sessionID: SessionID
  lastMessageInfo?: LastMessageInfo
  agentID?: string
}) {
  return runPromise((svc) =>
    svc.renderRebuildContext(input.sessionID, { lastMessageInfo: input.lastMessageInfo, agentID: input.agentID }),
  )
}

export async function lastBoundary(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.lastBoundary(input.sessionID))
}

export async function isWriterRunning(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.isWriterRunning(input.sessionID))
}

export * as SessionCheckpoint from "./checkpoint"

// Test-only re-export so test code can call composeWriterPrompt without
// triggering the full SessionCheckpoint Service stack.
export { composeWriterPrompt as composeWriterPromptForTest }
