import * as Tool from "./tool"
import type { ExecuteResult } from "./tool"
import DESCRIPTION from "./session.txt"
import SHELL_DESCRIPTION from "./session.shell.txt"
import { Effect, Cause, Deferred, Schema } from "effect"
import { tokenize } from "./shell-tokenize"
import { joinGroup } from "@opencode-ai/supervisor/group"
import { Session } from "../session/session"
import { InstanceState } from "../effect/instance-state"
import { Provider } from "../provider/provider"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { Supervisor } from "@opencode-ai/supervisor"
import { Inbox } from "@opencode-ai/inbox"
import { spawnRef } from "@opencode-ai/supervisor/spawn-ref"
import { forwardRef } from "@opencode-ai/core/permission/permission-forward-ref"
import { prefixCaptureRef } from "@opencode-ai/core/session/prefix-capture-ref"
import { Bus } from "@opencode-ai/bus"
import { TuiEvent } from "@opencode-ai/cli/cmd/tui/event"
import { SessionID, type MessageID } from "../session/schema"
import type { Interface as SupervisorInterface } from "@opencode-ai/supervisor/spawn"
import type { ForkContext } from "@opencode-ai/supervisor/spawn"
import { toLegacyProviderID, toLegacyModelID } from "@opencode-ai/core/provider/bridge"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Instance } from "@opencode-ai/project/instance"
import { InstanceRef } from "../effect/instance-ref"
import { Worktree } from "../worktree"
import { assembleFleet, deriveLiveness, renderFleetTable } from "./fleet"
import type { FleetActorInput, WorktreeEntry } from "./fleet"
import { classifySession } from "@opencode-ai/core/session/visibility"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { realpathSync } from "fs"

function canonicalPath(input: string): string {
  let real = input
  try {
    real = realpathSync(input)
  } catch {
    // Missing path: compare the normalized input as-is.
  }
  const normalized = path.normalize(real)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/**
 * A child owns a worktree only when the session tool created it: `create` with
 * `isolate` calls Worktree.create, which places worktrees under
 * `<Global.Path.data>/worktree/<projectID>`. Ownership therefore requires BOTH
 * that the directory lies under that root AND that git lists it as a worktree
 * entry. A plain directory (e.g. a subdirectory of a git repo) is never owned.
 * All arguments must be canonical (see canonicalPath).
 */
export function ownsWorktree(input: { directory: string; root: string; listed: ReadonlyArray<string> }): boolean {
  const prefix = input.root.endsWith(path.sep) ? input.root : input.root + path.sep
  return input.directory.startsWith(prefix) && input.listed.includes(input.directory)
}

/**
 * Removes the child's worktree only if the child owns one (see ownsWorktree).
 * Returns true only when a removal was actually performed. Worktree.remove
 * falls back to deleting a non-worktree directory, so it must never be called
 * for a directory this session did not create.
 */
export const removeOwnedWorktree = (directory: string, root: string) =>
  Effect.gen(function* () {
    const wtSvc = yield* Worktree.Service
    const listed = yield* wtSvc.list().pipe(Effect.catch(() => Effect.succeed([] as { directory: string }[])))
    const owned = ownsWorktree({
      directory: canonicalPath(directory),
      root: canonicalPath(root),
      listed: listed.map((wt) => canonicalPath(wt.directory)),
    })
    if (!owned) return false
    return yield* wtSvc.remove({ directory })
  })

function SIDE_QUESTION_PROMPT(question: string): string {
  return [
    "<system-reminder>",
    "This is a SIDE QUESTION about the session above (a frozen snapshot of its history).",
    "Answer it in a single response from that frozen context.",
    "You MAY use read-only tools (read/grep/glob) to inspect files, but you MUST NOT",
    "modify any file, run any command, or change any state. Do NOT continue, resume, or",
    "execute the session's underlying task -- just answer the question, then stop.",
    "</system-reminder>",
    "",
    question,
  ].join("\n")
}

function forkQuery(
  sessions: Session.Interface,
  provider: Provider.Interface,
  supervisor: SupervisorInterface,
  targetSessionID: SessionID,
  question: string,
) {
  return Effect.gen(function* () {
    const allMsgs = yield* sessions.messages({ sessionID: targetSessionID })
    const mainMsgsAll = allMsgs.filter((m: SessionV1.WithParts) => m.info.agent === "main")
    const hasMainActivity = mainMsgsAll.length > 0 && mainMsgsAll.some((m: SessionV1.WithParts) => m.info.role === "user")
    const mainMsgs = hasMainActivity ? mainMsgsAll : allMsgs
    const watermark: MessageID | undefined = mainMsgs.length > 0 ? mainMsgs[mainMsgs.length - 1].info.id : undefined
    if (!watermark || mainMsgs.length === 0 || !mainMsgs.some((m: SessionV1.WithParts) => m.info.role === "user"))
      return `(session ${targetSessionID} has no activity yet -- nothing to ask about.)`

    const lastAssistant = mainMsgs.findLast((m: SessionV1.WithParts) => m.info.role === "assistant")
    const agentName = lastAssistant?.info.agent ?? "build"

    const model = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!model) return "(fork-query unavailable: no default model configured)"

    const buildPrefix = prefixCaptureRef.current
    if (!buildPrefix) {
      const fallback = mainMsgs
        .map((m: SessionV1.WithParts) => {
          const role = m.info.role
          // opencode/src/tool/session.ts:71 (SessionV1.WithParts.parts) vs MessagePart[] structure
          const parts = m.parts as unknown as Array<{ type: string; text?: string }>
          const text = parts
            .filter((p: { type: string; text?: string }) => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
            .map((p: { type: string; text?: string }) => p.text as string)
            .join("\n")
          return text ? `[${role}]: ${text.slice(0, 2000)}` : null
        })
        .filter((v: string | null): v is string => v !== null)
        .join("\n\n")
      return fallback
        ? `Question: ${question}\n\nSession ${targetSessionID} history (prefix capture unavailable, showing raw history):\n\n${fallback}`
        : `(session ${targetSessionID} has activity but no text content to show -- prefix capture also unavailable.)`
    }
    const prefix = yield* buildPrefix({
      sessionID: targetSessionID,
      agentName,
      providerID: model.providerID as string,
      modelID: model.modelID as string,
      msgs: mainMsgs,
    })

    const childSession = yield* sessions.create({ parentID: targetSessionID, title: `ask: ${question.slice(0, 40)}` })

    const pID = toLegacyProviderID(model.providerID)
    const mID = toLegacyModelID(model.modelID)
    const result = yield* supervisor.spawn({
      mode: "subagent",
      sessionID: childSession.id,
      parentSessionID: targetSessionID,
      agentType: agentName,
      description: "fork-query",
      task: SIDE_QUESTION_PROMPT(question),
      context: "full",
      tools: ["read", "grep", "glob"],
      model: { providerID: pID, modelID: mID },
      background: false,
      lifecycle: "ephemeral",
      forkContext: {
        system: prefix.system,
        tools: prefix.tools,
        inheritedMessages: prefix.inheritedMessages,
        parentPermission: prefix.parentPermission,
        watermarkMsgID: watermark,
        model: { providerID: pID, modelID: mID },
      } satisfies ForkContext,
    })
    const outcome = yield* Deferred.await(result.outcome)
    if (outcome.status === "success") return outcome.finalText ?? "(no answer)"
    const reason = outcome.status === "failure" ? outcome.error : outcome.status
    return `(fork-query failed: ${reason})`
  })
}

export const TOPIC_MARKER = /^\[topic:([^\]]+)\]\s?/

function topicOf(title: string): string | undefined {
  const m = title.match(TOPIC_MARKER)
  return m ? m[1] : undefined
}

function tagTitle(topic: string, title: string): string {
  const base = title.replace(TOPIC_MARKER, "")
  return `[topic:${topic}] ${base}`
}

export function topicKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const id = "session"

// Shell-mode parser + flat-shape repair:
//   parseSessionScript turns a multi-line `session <verb> ...` script into the
//   nested `operation` envelope the live dispatch expects (mirrors the reference
//   implementation's parseTaskScript in tool/task.ts).
//   KNOWN_VERBS + suggestVerb + levenshtein give the model a typo-tolerant
//   unknown-verb error referencing the verb table.
//   extractSessionFlags / flagError / arityError / mapVerb implement the per-
//   verb grammar as defined upstream -- fork's valid mode set is
//   build|plan|harness, so the mode-flag check here mirrors recoverSessionArgs's
//   bare-create check.
const KNOWN_VERBS = [
  "create",
  "send",
  "switch",
  "list",
  "dashboard",
  "status",
  "cancel",
  "ask",
  "join",
  "setmode",
  "approve",
  "grant-approval",
]

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestVerb(input: string): string | undefined {
  const candidates = KNOWN_VERBS.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

function parseSessionScript(script: string): Effect.Effect<unknown[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: unknown[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "session") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `session: every command must start with 'session' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

function extractSessionFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): { flags: Record<string, string>; bools: Record<string, boolean>; rest: string[]; error?: string } {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  const bools: Record<string, boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const boolName = boolFlags.find((n) => a === `--${n}`)
    if (boolName) {
      bools[boolName] = true
      continue
    }
    const valName = valueFlags.find((n) => a === `--${n}`)
    if (valName) {
      const next = args[i + 1]
      if (next === undefined) return { flags, bools, rest, error: `--${valName} requires a value` }
      flags[valName] = next
      i++
      continue
    }
    const eq = valueFlags.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return { flags, bools, rest, error: `--${eq} requires a value` }
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return { flags, bools, rest }
}

function flagError(verb: string, detail: string, line: number) {
  return Effect.fail({ kind: "flag", line, detail: `session: ${verb}: ${detail}` })
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail:
      `session: ${verb}: arity mismatch\n` +
      `  got:      session ${verb} ${args.join(" ")}\n` +
      `  expected: session ${verb} ${expected}`,
  })
}

function mapVerb(verb: string | undefined, args: string[], line: number): Effect.Effect<unknown, unknown> {
  switch (verb) {
    case "create": {
      const { flags, bools, rest, error } = extractSessionFlags(
        args,
        ["mode", "model", "title", "dir", "topic"],
        ["isolate"],
      )
      if (error) return flagError("create", error, line)
      if (rest.length < 1)
        return arityError(
          "create",
          "<task...> [--mode build|plan|harness] [--model <ref>] [--title <t>] [--dir <path>] [--topic <label>] [--isolate]",
          rest,
          line,
        )
      if (flags.mode && flags.mode !== "build" && flags.mode !== "plan" && flags.mode !== "harness")
        return flagError("create", `--mode must be build, plan or harness (got '${flags.mode}')`, line)
      return Effect.succeed({
        operation: {
          action: "create" as const,
          task: rest.join(" "),
          ...(flags.mode ? { mode: flags.mode as "build" | "plan" | "harness" } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.title ? { title: flags.title } : {}),
          ...(flags.dir ? { dir: flags.dir } : {}),
          ...(flags.topic ? { topic: flags.topic } : {}),
          ...(bools.isolate ? { isolate: true } : {}),
        },
      })
    }
    case "send": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("send", error, line)
      if (rest.length < 2) return arityError("send", "<sessionID> <task...>", rest, line)
      return Effect.succeed({
        operation: { action: "send" as const, sessionID: rest[0], task: rest.slice(1).join(" ") },
      })
    }
    case "switch": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("switch", error, line)
      if (rest.length !== 1) return arityError("switch", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "switch" as const, sessionID: rest[0] } })
    }
    case "list": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("list", error, line)
      if (rest.length !== 0) return arityError("list", "", rest, line)
      return Effect.succeed({ operation: { action: "list" as const } })
    }
    case "dashboard": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("dashboard", error, line)
      if (rest.length !== 0) return arityError("dashboard", "", rest, line)
      return Effect.succeed({ operation: { action: "dashboard" as const } })
    }
    case "status": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("status", error, line)
      if (rest.length !== 1) return arityError("status", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "status" as const, sessionID: rest[0] } })
    }
    case "cancel": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("cancel", error, line)
      if (rest.length !== 1) return arityError("cancel", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "cancel" as const, sessionID: rest[0] } })
    }
    case "ask": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("ask", error, line)
      if (rest.length < 2) return arityError("ask", "<sessionID> <question...>", rest, line)
      return Effect.succeed({
        operation: { action: "ask" as const, session_id: rest[0], question: rest.slice(1).join(" ") },
      })
    }
    case "join": {
      const { flags, rest, error } = extractSessionFlags(args, ["timeout"])
      if (error) return flagError("join", error, line)
      if (rest.length < 1) return arityError("join", "<sessionID...> [--timeout <ms>]", rest, line)
      let timeout: string | undefined
      if (flags.timeout !== undefined) {
        const n = Number(flags.timeout)
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n))
          return flagError("join", `--timeout must be a positive integer (got '${flags.timeout}')`, line)
        timeout = String(n)
      }
      return Effect.succeed({
        operation: {
          action: "join" as const,
          sessionIDs: rest,
          ...(timeout !== undefined ? { timeout } : {}),
        },
      })
    }
    case "setmode": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("setmode", error, line)
      if (rest.length !== 2) return arityError("setmode", "<sessionID> <build|plan|harness>", rest, line)
      if (rest[1] !== "build" && rest[1] !== "plan" && rest[1] !== "harness")
        return flagError("setmode", `mode must be build, plan or harness (got '${rest[1]}')`, line)
      return Effect.succeed({
        operation: {
          action: "setmode" as const,
          sessionID: rest[0],
          mode: rest[1] as "build" | "plan" | "harness",
        },
      })
    }
    case "approve": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("approve", error, line)
      if (rest.length !== 1) return arityError("approve", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "approve" as const, sessionID: rest[0] } })
    }
    case "grant-approval": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("grant-approval", error, line)
      if (rest.length !== 1) return arityError("grant-approval", "<sessionID|all>", rest, line)
      return Effect.succeed({ operation: { action: "grant-approval" as const, target: rest[0] } })
    }
    default: {
      const suggestion = suggestVerb(verb ?? "")
      const detail =
        `session: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}



//  nested `operation` envelope with discriminated `action` union, so
// `{operation:{action:'status', sessionID:'ses_x'}}` validates cleanly and
// a flat `{action:'status', sessionID:'ses_x'}` is recovered via
// `recoverSessionArgs` (reference implementation session.ts:214-317 + 363-399).
const createOperation = Schema.Struct({
  action: Schema.Literal("create"),
  task: Schema.String.annotate({ description: "Task/prompt for child session (create/send)." }),
  mode: Schema.optional(Schema.String).annotate({ description: "Agent mode (build|plan|harness, default build)." }),
  model: Schema.optional(Schema.String).annotate({ description: "Model tier/ref for child (create)." }),
  title: Schema.optional(Schema.String).annotate({ description: "Title for child session (create)." }),
  dir: Schema.optional(Schema.String).annotate({ description: "Working directory for child (create)." }),
  isolate: Schema.optional(Schema.Boolean).annotate({
    description: "Run child in its own git worktree of dir (concurrent-edit isolation). Non-git dir falls back to shared.",
  }),
  topic: Schema.optional(Schema.String).annotate({
    description:
      "Topic label for child session. If a peer child already carries this topic, relay task into it instead of spawning.",
  }),
})
const sendOperation = Schema.Struct({
  action: Schema.Literal("send"),
  sessionID: Schema.String.annotate({ description: "Child session id to relay a new task to." }),
  task: Schema.String.annotate({ description: "The task/message to relay." }),
})
const switchOperation = Schema.Struct({
  action: Schema.Literal("switch"),
  sessionID: Schema.String.annotate({ description: "Session id to move the user's frontend panel to." }),
})
const listOperation = Schema.Struct({ action: Schema.Literal("list") })
const dashboardOperation = Schema.Struct({ action: Schema.Literal("dashboard") })
const statusOperation = Schema.Struct({
  action: Schema.Literal("status"),
  sessionID: Schema.String.annotate({ description: "Child session id to report derived liveness for." }),
})
const cancelOperation = Schema.Struct({
  action: Schema.Literal("cancel"),
  sessionID: Schema.String.annotate({ description: "Session id of the child session to stop." }),
})
const askOperation = Schema.Struct({
  action: Schema.Literal("ask"),
  session_id: Schema.String.annotate({ description: "Session id to ask a one-shot read-only side question." }),
  question: Schema.String.annotate({ description: "The side question to answer from a frozen snapshot." }),
})
const joinOperation = Schema.Struct({
  action: Schema.Literal("join"),
  sessionIDs: Schema.Array(Schema.String).annotate({ description: "Child session ids forming the dispatch group." }),
  timeout: Schema.optional(Schema.String).annotate({ description: "Join timeout in ms (join)." }),
})
const setmodeOperation = Schema.Struct({
  action: Schema.Literal("setmode"),
  sessionID: Schema.String.annotate({ description: "Session id whose mode to change." }),
  mode: Schema.String.annotate({ description: "New agent mode for the child's subsequent turns." }),
})
const approveOperation = Schema.Struct({
  action: Schema.Literal("approve"),
  sessionID: Schema.String.annotate({ description: "Child session id whose pending permission to approve." }),
})
const grantApprovalOperation = Schema.Struct({
  action: Schema.Literal("grant-approval"),
  target: Schema.String.annotate({ description: "A child session id to auto-approve, or 'all'." }),
})

export const Parameters = Schema.Struct({
  operation: Schema.Union([
    createOperation,
    sendOperation,
    switchOperation,
    listOperation,
    dashboardOperation,
    statusOperation,
    cancelOperation,
    askOperation,
    joinOperation,
    setmodeOperation,
    approveOperation,
    grantApprovalOperation,
  ]),
})

type Input = Schema.Schema.Type<typeof Parameters>
type Operation = Input["operation"]
type Metadata = { sessionID?: string }

//  recover a shell-mode / flattened / bare-{task} shape into the
// nested `operation` envelope above. Reference implementation session.ts:363-399.
// Route-only fields without `action` MUST NOT synthesize a `create` -- that
// would silently spawn a duplicate child (the route-first violation this
// recovery exists to prevent).
const ROUTE_ONLY_FIELDS = ["sessionID", "session_id", "sessionIDs", "question", "target"]
export function recoverSessionArgs(rawArgs: unknown): unknown {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  // (1) operation given as a JSON STRING -> parse it into a nested object.
  // Reference implementation session.ts:366-371.
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  // (2a) Already-nested operation -> validate and return or undefined.
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation)) {
    const parsed = Schema.decodeUnknownOption(Parameters)({ operation: obj.operation })
    return parsed._tag === "Some" ? parsed.value : undefined
  }
  // (2b) Flattened shape: top-level discriminator + operands as siblings.
  // Re-nest and validate against the real union (reference session.ts:383-388
  // -- shell-wrap hands a recovered value straight to def.execute WITHOUT
  // re-validating it, so validating here is what makes the reconstruction
  // safe; an unvalidated shape surfaces as an "invalid arguments" error
  // rather than being coerced).
  const action =
    typeof obj.action === "string" ? obj.action : typeof obj.operation === "string" ? obj.operation : undefined
  if (action !== undefined) {
    const operands = Object.fromEntries(
      Object.entries(obj).filter(([k]) => k !== "operation" && k !== "action"),
    )
    const candidate = { operation: { ...operands, action } }
    const parsed = Schema.decodeUnknownOption(Parameters)(candidate)
    return parsed._tag === "Some" ? parsed.value : undefined
  }
  // (3) Bare {task} with no ROUTE_ONLY_FIELDS -> synthesize create. mode must
  // match the fork's valid set (build|plan|harness per the rename);
  // invalid modes are silently dropped, matching upstream session.ts:392.
  if (typeof obj.task === "string" && !ROUTE_ONLY_FIELDS.some((field) => obj[field] !== undefined)) {
    const op: Record<string, unknown> = { action: "create", task: obj.task }
    if (obj.mode === "build" || obj.mode === "plan" || obj.mode === "harness") op.mode = obj.mode
    if (typeof obj.model === "string") op.model = obj.model
    if (typeof obj.title === "string") op.title = obj.title
    if (typeof obj.topic === "string") op.topic = obj.topic
    return { operation: op }
  }
  return undefined
}

export const SessionTool = Tool.define<
  typeof Parameters,
  Metadata,
  Session.Service | Provider.Service | SupervisorRegistryService.Service | Inbox.Service | Bus.Service | Worktree.Service
>(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const supervisorReg = yield* SupervisorRegistryService.Service
    const inboxSvc = yield* Inbox.Service
    const bus = yield* Bus.Service

    // Children a user can treat as conversations. Same gate as the TUI session
    // list (tui component/dialog-session-list.tsx:85): a child hosting a
    // runtime-spawned agent (checkpoint writer) is bookkeeping, not a
    // conversation (core session/visibility.ts).
    const conversationChildren = (parentID: SessionID) =>
      Effect.gen(function* () {
        const children = yield* sessions.children(parentID)
        const verdicts = yield* Effect.forEach(children, (child) =>
          supervisorReg
            .listBySession(child.id)
            .pipe(Effect.map((rows) => classifySession(child, rows.map((r) => ({ mode: r.mode, agent: r.agent }))).renderable)),
        )
        return children.filter((_, i) => verdicts[i])
      })

    // The supervisor row a child session hosts. A peer row is keyed (session, session id); a
    // subagent row is keyed (child session, "<agent>-N") by spawnSubagent, so both are read with
    // listBySession. Among several subagent rows the most recently updated one wins.
    const childSupervisorRow = (sessionID: SessionID) =>
      supervisorReg.listBySession(sessionID).pipe(
        Effect.map((rows): Supervisor | undefined => {
          const peer = rows.find((row) => row.supervisorID === sessionID)
          if (peer) return peer
          const subagents = rows.filter((row) => row.mode === "subagent" && row.supervisorID !== "main")
          return subagents.sort((a, b) => b.time.updated - a.time.updated)[0]
        }),
      )

    const requireSupervisor = () => {
      const a = spawnRef.current
      if (!a) return Effect.fail(new Error("Supervisor service unavailable"))
      return Effect.succeed(a)
    }

    const run = (input: Input, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const action = input.operation.action
        const op = input.operation
        const opSid = (op as { sessionID?: string; session_id?: string }).sessionID ??
          (op as { session_id?: string }).session_id
        const requireSid = (act: string) =>
          opSid
            ? Effect.succeed(opSid)
            : Effect.fail(
                new Tool.InvalidArgumentsError({
                  tool: id,
                  detail: `${act} requires sessionID (alias session_id accepted) — got neither`,
                }),
              )

        if (action === "create") {
          const createOp = op as Extract<Operation, { action: "create" }>
          const supervisor = yield* requireSupervisor()

          if (createOp.topic) {
            const topic = createOp.topic
            const children = yield* sessions.children(ctx.sessionID as SessionID)
            const enriched = yield* Effect.forEach(children, (child: { id: string; title: string }) =>
              childSupervisorRow(child.id as SessionID).pipe(Effect.map((sup: Supervisor | undefined) => ({ child, sup }))),
            )
            const match = enriched.find(({ child, sup }: { child: { id: string; title: string }; sup: Supervisor | undefined }) => {
              if (sup?.mode === "subagent") return false
              const existing = topicOf(child.title)
              return existing !== undefined && topicKey(existing) === topicKey(topic)
            })
            if (match) {
              const childID = match.child.id as string
              const sendResult = yield* inboxSvc
                .send({
                  receiverSessionID: SessionID.make(childID),
                  receiverSupervisorID: childID,
                  senderSessionID: ctx.sessionID,
                  senderSupervisorID: ctx.supervisorID ?? "main",
                  content: createOp.task ?? "",
                })
                .pipe(
                  Effect.catchCause((cause: unknown) =>
                    Effect.logWarning("session tool topic relay inbox send failed", { cause: Cause.pretty(cause as never) }).pipe(
                      Effect.as({ inboxID: null as string | null }),
                    ),
                  ),
                )
              if (sendResult.inboxID !== null) {
                return {
                  title: `Reused topic '${topic}' → relayed to ${childID}`,
                  output: `Found standing child ${childID} for topic '${topic}'. Enqueued the task into it and woke it — it runs the relayed task as its next turn.`,
                  metadata: { sessionID: childID as string },
                }
              }
            }
          }

          const targetDir = createOp.dir ?? (yield* InstanceState.directory)
          const isolateInput: { effectiveDir: string; isolateNotice: string } = yield* Effect.gen(function* () {
            if (!createOp.isolate) return { effectiveDir: targetDir, isolateNotice: "" }
            const derivedName = (createOp.title ?? createOp.topic ?? (createOp.task ?? "").slice(0, 30)).trim().slice(0, 40)
            const wtOutcome = yield* Effect.gen(function* () {
              const wtSvc = yield* Worktree.Service
              const info = yield* wtSvc.create(derivedName ? { name: derivedName } : undefined)
              return { ok: true as const, info }
            }).pipe(
              Effect.catch((error: unknown) => {
                const tagged = error as { _tag?: string; message?: string }
                const msg = error instanceof Error ? error.message : (tagged.message ?? String(error))
                return Effect.succeed({ ok: false as const, tag: tagged._tag, message: msg })
              }),
              Effect.catchDefect((defect: unknown) => Effect.succeed({ ok: false as const, tag: undefined as string | undefined, message: String(defect) })),
            )
            if (wtOutcome.ok) return { effectiveDir: wtOutcome.info.directory, isolateNotice: "" }
            if (wtOutcome.tag === "WorktreeNotGitError")
              return { effectiveDir: targetDir, isolateNotice: " (note: --isolate ignored — directory is not a git repo; running shared)" }
            return {
              effectiveDir: targetDir,
              isolateNotice: ` (note: --isolate worktree creation failed (${wtOutcome.message}); running shared)`,
            }
          })
          const effectiveDir = isolateInput.effectiveDir
          const isolateNotice = isolateInput.isolateNotice

          const taskText = createOp.task
          if (!taskText)
            return yield* Effect.fail(
              new Tool.InvalidArgumentsError({ tool: id, detail: "create requires task" }),
            )
          const model = createOp.model
            ? yield* provider
                .resolveModelRef(createOp.model, undefined)
                .pipe(
                  Effect.map((m) => ({
                    providerID: toLegacyProviderID(m.providerID),
                    modelID: toLegacyModelID(m.id),
                  })),
                )
            : undefined
          const result = yield* supervisor.spawn({
            mode: "peer",
            sessionID: ctx.sessionID as SessionID,
            agentType: createOp.mode ?? "build",
            task: taskText,
            description: createOp.title ?? taskText.slice(0, 40),
            context: "none" as const,
            tools: "INHERIT" as const,
            background: true,
            parentSupervisorID: ctx.supervisorID,
            lifecycle: "persistent" as const,
            cwd: effectiveDir,
            ...(model ? { model } : {}),
          })
          if (createOp.topic) {
            const topic = createOp.topic
            const base = createOp.title ?? `${createOp.mode ?? "build"}: ${taskText.slice(0, 40)}`
            yield* sessions.setTitle({ sessionID: result.sessionID, title: tagTitle(topic, base) })
          } else if (createOp.title) yield* sessions.setTitle({ sessionID: result.sessionID, title: createOp.title })
          return {
            title: `Session created: ${result.sessionID}`,
            output:
              `Created child session ${result.sessionID} (mode: ${createOp.mode ?? "build"}) in ${effectiveDir}.` +
              (createOp.topic ? ` Tagged with topic '${createOp.topic}' for reuse.` : ``) +
              (createOp.isolate && !isolateNotice ? ` Isolated in its own worktree.` : isolateNotice) +
              ` Running in background.`,
            metadata: { sessionID: result.sessionID as string },
          }
        }

        if (action === "switch") {
          const s = yield* requireSid("switch")
          yield* bus.publish(TuiEvent.SessionSelect, { sessionID: s as SessionID })
          return { title: `Switched to ${s}`, output: `Requested UI navigate to session ${s}.`, metadata: { sessionID: s } }
        }

        if (action === "list") {
          const children = yield* conversationChildren(ctx.sessionID as SessionID)
          if (children.length === 0) return { title: "Child sessions: 0", output: "No child sessions.", metadata: {} as Metadata }
          return { title: `Child sessions: ${children.length}`, output: children.map((c) => `${c.id} -- ${c.title}`).join("\n"), metadata: {} as Metadata }
        }

        if (action === "dashboard") {
          const children = yield* conversationChildren(ctx.sessionID as SessionID)
          const enriched = yield* Effect.forEach(children, (child: { id: string; title: string; directory: string }) =>
            childSupervisorRow(child.id as SessionID).pipe(Effect.map((sup: Supervisor | undefined) => ({ child, sup }))),
          )
          const peers = enriched.filter(({ sup }: { sup: Supervisor | undefined }) => sup?.mode !== "subagent")
          if (peers.length === 0) return { title: "Fleet: 0", output: "No child sessions.", metadata: {} as Metadata }

          const worktrees: WorktreeEntry[] = yield* Effect.gen(function* () {
            const wtSvc = yield* Worktree.Service
            const listed = yield* wtSvc.list().pipe(Effect.catch(() => Effect.succeed([] as WorktreeEntry[])))
            return listed.map((wt: { directory: string; branch?: string }) => ({ directory: wt.directory, branch: wt.branch }))
          }).pipe(Effect.catch(() => Effect.succeed([] as WorktreeEntry[])))

          const inputs: FleetActorInput[] = peers.map(({ child, sup }: { child: { id: string; title: string; directory: string }; sup: Supervisor | undefined }) => ({
            session: { id: child.id, title: child.title, directory: child.directory },
            supervisor: sup ?? null,
          }))
          const summary = assembleFleet(inputs, worktrees, Date.now())
          return { title: `Fleet: ${summary.total}`, output: renderFleetTable(summary), metadata: {} as Metadata }
        }

        if (action === "cancel") {
          const s = yield* requireSid("cancel")
          const supervisor = yield* requireSupervisor()
          const cancelRow = yield* childSupervisorRow(s as SessionID)
          yield* supervisor.cancel(s as SessionID, cancelRow?.supervisorID ?? s, "graceful")
          // Remove the child's worktree only when this session tool created it
          // with `isolate` (see ownsWorktree / removeOwnedWorktree). A child in a
          // plain directory, including a subdirectory of a git repo, owns no
          // worktree and is never touched. The removal runs in ITS OWN project's
          // Instance (InstanceRef from the child dir), because `git worktree
          // remove` resolves against the ambient Instance.
          // Best-effort throughout (Effect.exit): never fail the cancel.
          const child = yield* sessions.get(s as SessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
          let removed = false
          if (child) {
            const ctxExit = yield* Effect.exit(
              Effect.promise(() => Instance.provide({ directory: child.directory, fn: () => Instance.current })),
            )
            if (ctxExit._tag === "Success") {
              const root = path.join(Global.Path.data, "worktree", ctxExit.value.project.id)
              const remExit = yield* removeOwnedWorktree(child.directory, root).pipe(
                Effect.provideService(InstanceRef, ctxExit.value),
                Effect.exit,
              )
              removed = remExit._tag === "Success" ? remExit.value : false
            }
          }
          return {
            title: `Cancelled ${s}`,
            output: `Cancelled session ${s}.` + (removed ? ` Removed its worktree (branch deleted).` : ``),
            metadata: { sessionID: s },
          }
        }

        if (action === "ask") {
          const s = yield* requireSid("ask")
          const supervisor = yield* requireSupervisor()
          const q = input.operation.question
          if (!q) return yield* Effect.fail(new Tool.InvalidArgumentsError({ tool: id, detail: "ask requires question" }))
          const answer = yield* forkQuery(sessions, provider, supervisor, s as SessionID, q)
          return { title: `Asked ${s}`, output: answer, metadata: { sessionID: s } as Metadata }
        }

        if (action === "setmode") {
          const s = yield* requireSid("setmode")
          const childID = s as SessionID
          const mode = input.operation.mode ?? "build"
          const slice = yield* sessions.messages({ sessionID: childID })
          const lastUser = slice.findLast((m: { info: { role: string } }) => m.info?.role === "user")
          const lastAssistant = slice.findLast((m: { info: { role: string } }) => m.info?.role === "assistant")
          for (const m of [lastUser, lastAssistant]) {
            if (m) yield* sessions.updateMessage({ ...m.info, agent: mode })
          }
          const took = lastUser || lastAssistant
          return {
            title: `Set mode of ${s} to ${mode}`,
            output: took ? `Child session ${s} will run its next turn in ${mode} mode.` : `Set child ${s} mode to ${mode} (no turns yet).`,
            metadata: { sessionID: s } as Metadata,
          }
        }

        if (action === "grant-approval") {
          const t = input.operation.target
          if (!t) return yield* Effect.fail(new Tool.InvalidArgumentsError({ tool: id, detail: "grant-approval requires target" }))
          forwardRef.setGrant(ctx.sessionID, t === "all" ? "*" : t)
          return {
            title: `Approval granted for ${t}`,
            output: t === "all" ? `Future permission asks from ANY child will be auto-approved.` : `Future permission asks from child ${t} will be auto-approved.`,
            metadata: {} as Metadata,
          }
        }

        if (action === "approve") {
          const s = yield* requireSid("approve")
          const approved = forwardRef.resolve(s, "allow")
          return {
            title: approved ? `Approved ${s}` : `No pending approval for ${s}`,
            output: approved ? `Approved child ${s}'s pending permission request.` : `Child ${s} has no pending permission request.`,
            metadata: { sessionID: s },
          }
        }

        if (action === "send") {
          const sid = yield* requireSid("send")
          const sendResult = yield* inboxSvc
            .send({
              receiverSessionID: SessionID.make(sid),
              receiverSupervisorID: sid,
              senderSessionID: ctx.sessionID,
              senderSupervisorID: ctx.supervisorID ?? "main",
              content: input.operation.task ?? "",
            })
            .pipe(
              Effect.catchCause((cause: unknown) =>
                Effect.logWarning("session tool send inbox failed", { cause: Cause.pretty(cause as never) }).pipe(
                  Effect.as({ inboxID: null as string | null } as { inboxID: string | null }),
                ),
              ),
            )
          return {
            title: `Sent to ${sid}`,
            output: sendResult.inboxID
              ? `Enqueued the task into child ${sid} and woke it. It will pick it up as its next turn and report back via notification.`
              : `session ${sid} not found or has no inbox receiver -- nothing was enqueued.`,
            metadata: { sessionID: sid } as Metadata,
          }
        }

        if (action === "status") {
          const sid = yield* requireSid("status")
          const entry = yield* childSupervisorRow(SessionID.make(sid))
          if (!entry) {
            return {
              title: `session status ${sid}`,
              metadata: {} as Metadata,
              output: JSON.stringify({ status: "unknown", session_id: sid }),
            }
          }
          // opencode/src/tool/session.ts:833 (supervisor registry entry) vs Supervisor schema
          const livenessRaw = deriveLiveness(entry as unknown as Supervisor, Date.now())
          const stalled = livenessRaw === "stalled"
          const terminal = livenessRaw === "idle" || livenessRaw === "failure" || livenessRaw === "cancelled"
          const liveness = terminal ? "terminal" : stalled ? "stalled" : "progressing"
          return {
            title: `session status ${sid}`,
            metadata: { sessionID: sid } as Metadata,
            output: JSON.stringify({
              session_id: sid,
              liveness,
              status: entry.status,
              turnCount: entry.turnCount,
              lastTurnTime: entry.lastTurnTime,
              ...(entry.lastOutcome !== undefined ? { lastOutcome: entry.lastOutcome } : {}),
              time: entry.time,
            }),
          }
        }

        if (action === "join") {
          const ids = input.operation.sessionIDs ?? []
          if (ids.length === 0) return yield* Effect.fail(new Error("session: join requires at least one sessionID"))
          const members = ids.map((sid: string) => ({ sessionID: sid as SessionID, supervisorID: sid }))
          const timeoutMs = input.operation.timeout !== undefined ? Number(input.operation.timeout) : undefined
          // opencode/src/tool/session.ts:858 (Session.Service) vs supervisor/group SessionMessages
          const agg = yield* joinGroup(
            { reg: supervisorReg, sessions: sessions as unknown as import("@opencode-ai/supervisor/group").SessionMessages, bus },
            { members, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) },
          )
          const lines = agg.members.map((m: { supervisorID: string; description?: string; outcome: string; status?: string; turnCount?: number; reportedSummary?: string; result?: string; error?: string }) => {
            const who = m.description ? `${m.supervisorID} (${m.description})` : m.supervisorID
            const detail =
              m.outcome === "success"
                ? (m.reportedSummary ?? (m.result ? m.result.slice(0, 200) : "done"))
                : m.outcome === "failure"
                  ? (m.error ?? "failed")
                  : m.outcome === "cancelled"
                    ? "cancelled"
                    : m.outcome === "running"
                      ? `still running (status ${m.status ?? "?"}, ${m.turnCount ?? 0} turns) -- poll with status or join again`
                      : "unknown (no registered supervisor)"
            return `  ${who} -- ${m.outcome}: ${detail}`
          })
          const header =
            agg.status === "timeout"
              ? `Join TIMED OUT -- ${agg.counts.success + agg.counts.failure + agg.counts.cancelled}/${agg.total} children terminal`
              : `Join complete -- all ${agg.total} children terminal`
          const tally =
            `${agg.counts.success} success, ${agg.counts.failure} failed, ${agg.counts.cancelled} cancelled` +
            (agg.counts.running > 0 ? `, ${agg.counts.running} still running` : "") +
            (agg.counts.unknown > 0 ? `, ${agg.counts.unknown} unknown` : "")
          return {
            title: agg.status === "timeout" ? `Join timed out (${agg.total} children)` : `Joined ${agg.total} children`,
            output: [`${header} (${tally}).`, "", ...lines].join("\n"),
            metadata: {} as Metadata,
          }
        }

        return yield* Effect.fail(new Error(`session: unhandled action: ${action}`))
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Input, ctx: Tool.Context) => run(args, ctx).pipe(Effect.orDie) as Effect.Effect<ExecuteResult<Metadata>, never, never>,
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseSessionScript,
        recover: recoverSessionArgs,
      },
    } as unknown as Tool.DefWithoutID<typeof Parameters, Metadata> // opencode/src/tool/session.ts:899 (Tool definition shape)
  }),
)
