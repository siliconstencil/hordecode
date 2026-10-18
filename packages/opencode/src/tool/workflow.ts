import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Effect, Fiber, Schema } from "effect"
import { Config } from "../config/config"
import { ConfigHarness } from "@opencode-ai/core/config/harness"
import { InstanceState } from "../effect/instance-state"
import { workflowRef } from "@opencode-ai/workflow/runtime-ref"
import { BuiltinWorkflow } from "@opencode-ai/workflow/builtin"
import type { SessionID } from "../session/schema"

const id = "workflow"

function parseWorkflowArgString(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
  } catch {}
  return { task: raw }
}

function parseArgsAsQuestion(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
  } catch {}
  return { question: raw }
}

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["run", "status", "wait", "cancel", "resume"]).annotate({
    description: "run | status | wait | cancel | resume",
  }),
  name: Schema.optional(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: '(optional) Built-in workflow name (e.g. "deep-research").',
    }),
  ),
  script: Schema.optional(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "(optional) Inline JS workflow script.",
    }),
  ),
  args: Schema.optional(Schema.Any).annotate({ description: "(optional) JSON args exposed to script." }),
  workspace: Schema.optional(
    Schema.String.annotate({ description: "(optional) Absolute workspace dir for script." }),
  ),
  async: Schema.optional(
    Schema.Boolean.annotate({ description: "(optional) Run in background, return run_id immediately." }),
  ),
  run_id: Schema.optional(
    Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Workflow run id. Required for status/wait/cancel/resume." }),
  ),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Optional timeout in ms for wait." }),
  ),
})

type Input = Schema.Schema.Type<typeof Parameters>

type TranscriptEntry = { kind: "phase" | "log"; text: string }
type Metadata = {
  runID: string
  status: string
  transcript?: TranscriptEntry[]
  counters?: { running: number; succeeded: number; failed: number }
  currentPhase?: string
}

const TRANSCRIPT_HEAD = 40
const TRANSCRIPT_TAIL = 160
function capTranscript(t: readonly TranscriptEntry[]): TranscriptEntry[] {
  if (t.length <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL + 1) return t.slice()
  const omitted = t.length - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL
  return [
    ...t.slice(0, TRANSCRIPT_HEAD),
    { kind: "log" as const, text: `...(${omitted} lines omitted)` },
    ...t.slice(t.length - TRANSCRIPT_TAIL),
  ]
}

function renderWorkflowCatalog(): string {
  const list = BuiltinWorkflow.list()
  if (list.length === 0) return ""
  const entries = list.map((w) => {
    const phases = w.phases?.length ? "\n  Phases: " + w.phases.map((p) => p.title).join(" → ") : ""
    const when = w.whenToUse ? `\n  When to use: ${w.whenToUse}` : ""
    return `- ${w.name}: ${w.description}${when}${phases}`
  })
  return [
    "",
    "## Built-in workflows",
    'These named workflows are available via operation "run" with `name`. When a request matches one, invoke it instead of writing a script from scratch:',
    "",
    ...entries,
    "",
    'Invoke a built-in: workflow({ operation: "run", name: "deep-research", args: "<the refined request>" })',
  ].join("\n")
}

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, Config.Service>(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const requireRuntime = () => {
      const runtime = workflowRef.current
      if (!runtime) {
        return Effect.fail(new Error("Workflow runtime unavailable"))
      }
      return Effect.succeed(runtime)
    }

    const enrichHarnessArgs = (raw: unknown) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const cfg = yield* config.get()
        const harnessCfg = (cfg as unknown as { harness?: unknown }).harness
        const docs = ConfigHarness.resolveDocsDir(ctx.worktree, harnessCfg as never)
        const base =
          typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>)
            : typeof raw === "string"
              ? parseWorkflowArgString(raw)
              : {}
        return { ...base, _harnessDocsDir: docs }
      })

    // Inject dir (workspace root) + today (host date): scripts write into a real
    // workspace and get a deterministic date since the sandbox neuters Date.
    const enrichDeepResearchArgs = (raw: unknown, workspace?: string) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const resolvedWorkspace = workspace ?? ctx.worktree
        const base =
          typeof raw === "object" && raw !== null
            ? { ...(raw as Record<string, unknown>) }
            : typeof raw === "string"
              ? parseArgsAsQuestion(raw)
              : {}
        if (!base.dir) base.dir = resolvedWorkspace
        if (!base.today) base.today = new Date().toISOString().slice(0, 10)
        return base
      })

    const run = (input: Input, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const runtime = yield* requireRuntime()

        if (input.operation === "run") {
          if (input.name && input.script) {
            return yield* Effect.fail(
              new Error("workflow run: provide either `name` or `script`, not both."),
            )
          }
          const script = input.name ? BuiltinWorkflow.get(input.name)?.script : input.script
          if (!script) {
            const known = BuiltinWorkflow.list()
              .map((w) => w.name)
              .join(", ")
            return yield* Effect.fail(
              new Error(
                input.name
                  ? `Unknown built-in workflow "${input.name}". Known: ${known || "(none)"}.`
                  : "workflow run requires either `name` or `script`.",
              ),
            )
          }
          const cfg = yield* config.get()
          // interactive: whether a human is attached to this turn (computed by
          // decideAskRouting in SessionTools.resolve -- same routing ctx.ask uses).
          // The workflow runtime's up-front meta.permissions manifest ask fails
          // CLOSED when interactive is false; the tool must forward the real value
          // or a foreground TUI launch could never prompt (agents auto-denied).
          const started = yield* runtime.start({
            script,
            sessionID: ctx.sessionID as SessionID,
            parentSupervisorID: ctx.supervisorID ?? "main",
            args:
              input.name === "harness"
                ? yield* enrichHarnessArgs(input.args)
                : input.name === "deep-research"
                  ? yield* enrichDeepResearchArgs(input.args, input.workspace)
                  : input.args,
            workspace: input.workspace,
            maxConcurrentAgents: cfg.workflow?.maxConcurrentAgents,
            scriptDeadlineMs: cfg.workflow?.scriptDeadlineMs,
            notifyOnTerminal: input.async === true,
            interactive: ctx.interactive,
          })
          const runID = started.runID
          const label = input.name ?? "inline"

          if (input.async === true) {
            return { title: "workflow started", output: `Background run_id: ${runID}`, metadata: { runID, status: "running" as const } }
          }

          yield* ctx.metadata({ metadata: { runID, status: "running" as const, transcript: [] } })

          let lastLen = 0
          let lastCounters = ""
          const flushFiber = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("250 millis")
                const t = yield* runtime.transcript({ runID })
                const s = yield* runtime.status({ runID })
                const counters = { running: s.running, succeeded: s.succeeded, failed: s.failed }
                const countersKey = `${counters.running}/${counters.succeeded}/${counters.failed}`
                if (t.length === lastLen && countersKey === lastCounters) continue
                lastLen = t.length
                lastCounters = countersKey
                yield* ctx.metadata({
                  metadata: {
                    runID, status: "running" as const,
                    transcript: capTranscript(t), counters,
                    ...(s.currentPhase !== undefined ? { currentPhase: s.currentPhase } : {}),
                  },
                })
              }
            }),
          )

          const outcome = yield* runtime.wait({ runID })
          yield* Fiber.interrupt(flushFiber)

          const finalStatus = yield* runtime.status({ runID })
          const finalTranscript = capTranscript(yield* runtime.transcript({ runID }))
          const lines = finalTranscript.map((e) => (e.kind === "phase" ? `> ${e.text}` : `  ${e.text}`))

          if (outcome.status === "completed") {
            const result = JSON.stringify(outcome.result ?? null)
            const truncated = result.length > 4000 ? result.slice(0, 4000) + " ...(truncated)" : result
            return { title: `workflow ${label} completed`, output: (lines.length ? lines.join("\n") + "\n\n" : "") + `Result: ${truncated}\nrun_id: ${runID}`, metadata: { runID, status: "completed" as const, transcript: finalTranscript, counters: { running: finalStatus.running, succeeded: finalStatus.succeeded, failed: finalStatus.failed }, currentPhase: finalStatus.currentPhase } }
          }
          if (outcome.status === "failed") {
            return { title: `workflow ${label} failed`, output: (lines.length ? lines.join("\n") + "\n\n" : "") + `Error: ${outcome.error}\nrun_id: ${runID}`, metadata: { runID, status: "failed" as const, transcript: finalTranscript, counters: { running: finalStatus.running, succeeded: finalStatus.succeeded, failed: finalStatus.failed }, currentPhase: finalStatus.currentPhase } }
          }
          return { title: `workflow ${label} cancelled`, output: (lines.length ? lines.join("\n") + "\n\n" : "") + `Cancelled.\nrun_id: ${runID}`, metadata: { runID, status: "cancelled" as const, transcript: finalTranscript, counters: { running: finalStatus.running, succeeded: finalStatus.succeeded, failed: finalStatus.failed }, currentPhase: finalStatus.currentPhase } }
        }
        if (input.operation === "status") {
          const snapshot = yield* runtime.status({ runID: input.run_id! })
          return { title: `workflow ${snapshot.status}`, output: JSON.stringify(snapshot), metadata: { runID: input.run_id!, status: snapshot.status || "unknown" } }
        }
        if (input.operation === "wait") {
          const outcome = yield* runtime.wait({ runID: input.run_id!, timeoutMs: input.timeout_ms })
          return { title: `workflow ${outcome.status}`, output: JSON.stringify(outcome), metadata: { runID: input.run_id!, status: outcome.status || "unknown" } }
        }
        if (input.operation === "cancel") {
          yield* runtime.cancel({ runID: input.run_id! })
          return { title: "workflow cancelled", output: `Cancelled ${input.run_id}`, metadata: { runID: input.run_id!, status: "cancelled" as const } }
        }
        if (input.operation === "resume") {
          const resumed = yield* runtime.resume({ runID: input.run_id! })
          return { title: resumed.resumed ? "workflow resumed" : "workflow not resumable", output: JSON.stringify(resumed), metadata: { runID: input.run_id!, status: resumed.resumed ? ("running" as const) : ("completed" as const) } }
        }
        throw new Error(`unhandled workflow operation: ${input.operation}`)
      })

    const catalog = renderWorkflowCatalog()

    return {
      description: DESCRIPTION + catalog,
      parameters: Parameters,
      execute: (input: Input, ctx: Tool.Context) =>
        run(input, ctx).pipe(Effect.scoped, Effect.orDie),
    }
  }),
)
