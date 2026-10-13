export * as TuiEvent from "./tui-event"

import { Effect, Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { PositiveInt } from "./schema"
import { SessionID } from "./session-id"

const DEFAULT_TOAST_DURATION = 5000

export const PromptAppend = Event.define({ type: "tui.prompt.append", schema: { text: Schema.String } })

export const CommandExecute = Event.define({
  type: "tui.command.execute",
  schema: {
    command: Schema.Union([
      Schema.Literals([
        "session.list",
        "session.new",
        "session.share",
        "session.interrupt",
        "session.compact",
        "session.page.up",
        "session.page.down",
        "session.line.up",
        "session.line.down",
        "session.half.page.up",
        "session.half.page.down",
        "session.first",
        "session.last",
        "prompt.clear",
        "prompt.submit",
        "agent.cycle",
      ]),
      Schema.String,
    ]),
  },
})

export const ToastShow = Event.define({
  type: "tui.toast.show",
  schema: {
    title: optional(Schema.String),
    message: Schema.String,
    variant: Schema.Literals(["info", "success", "warning", "error"]),
    duration: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({
      description: "Duration in milliseconds",
    }),
  },
})

export const SessionSelect = Event.define({
  type: "tui.session.select",
  schema: {
    sessionID: SessionID.annotate({ description: "Session ID to navigate to" }),
  },
})

export const InstructionsLoaded = Event.define({
  type: "tui.instructions.loaded",
  schema: {
    files: Schema.Array(Schema.String).annotate({
      description: "Display labels of loaded instruction files: worktree-relative path, ~-path, or absolute",
    }),
  },
})

export const TryBestDetected = Event.define({
  type: "session.try_best.detected",
  schema: {
    sessionID: SessionID,
    agentID: optional(Schema.String),
    providerID: Schema.String,
    modelID: Schema.String,
    reason: Schema.Literals(["edit_repeat", "bash_retry", "action_streak"]),
    evidence: Schema.Struct({
      tool: Schema.String,
      path: optional(Schema.String),
      command: optional(Schema.String),
      count: PositiveInt,
      similarity: optional(Schema.Number),
      action: optional(Schema.Literals(["edit", "verify"])),
    }),
  },
})

export const SupervisorStuck = Event.define({
  type: "supervisor.stuck",
  schema: {
    sessionID: SessionID,
    supervisorID: Schema.String,
    description: Schema.String,
    lastTurnTime: Schema.Int,
    stuckDuration: Schema.Int,
  },
})

export const Definitions = Event.inventory(
  PromptAppend,
  CommandExecute,
  ToastShow,
  SessionSelect,
  InstructionsLoaded,
  TryBestDetected,
  SupervisorStuck,
)
