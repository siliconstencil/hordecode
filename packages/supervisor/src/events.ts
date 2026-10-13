import { BusEvent } from "@opencode-ai/bus/bus-event"
import { SessionID } from "@opencode-ai/core/session/schema"
import { SupervisorStatus, SupervisorOutcome, SpawnMode } from "./schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"
import z from "zod"

export const SupervisorRegistered = BusEvent.define(
  "supervisor.registered",
  z.object({
    sessionID: SessionID.zod,
    supervisorID: z.string(),
    mode: SpawnMode,
    parentSupervisorID: z.string().optional(),
    description: z.string(),
    agent: z.string(),
    background: z.boolean(),
  }),
)

export const SupervisorStatusChanged = BusEvent.define(
  "supervisor.status",
  z.object({
    sessionID: SessionID.zod,
    supervisorID: z.string(),
    status: SupervisorStatus,
    lastOutcome: SupervisorOutcome.optional(),
    turnCount: z.number(),
    lastTurnTime: z.number(),
    error: z.string().optional(),
  }),
)

export const SupervisorStuck = BusEvent.define(
  "supervisor.stuck",
  z.object({
    sessionID: SessionID.zod,
    supervisorID: z.string(),
    description: z.string(),
    lastTurnTime: z.number(),
    stuckDuration: z.number(),
  }),
)

// Added for the scanStalled watchdog -- fires when a supervisor flips to
// "stalled" liveness. Same payload shape as the corresponding upstream
// "supervisor.stalled" event (see upstream reference implementation,
// events.ts:52). The consumer side, renderSupervisorNotification, was
// already ported in packages/inbox/src/render.ts:15.
export const SupervisorStalled = BusEvent.define(
  "supervisor.stalled",
  z.object({
    sessionID: SessionID.zod,
    supervisorID: z.string(),
    description: z.string(),
    lastActivityTime: z.number(),
    stalledDuration: z.number(),
  }),
)

export const WriterCachePerf = BusEvent.define(
  "writer.cache_perf",
  z.object({
    sessionID: SessionID.zod,
    writerSupervisorID: z.string(),
    status: z.enum(["completed", "failed"]),
    total_input_tokens: z.number(),
    cache_read_tokens: z.number(),
    cache_write_tokens: z.number(),
    cache_hit_rate: z.number(),
    num_llm_calls: z.number(),
  }),
)

export const InboxArrived = BusEvent.define(
  "inbox.arrived",
  z.object({
    receiverSessionID: SessionID.zod,
    receiverSupervisorID: z.string(),
    senderSessionID: SessionID.zod.optional(),
    senderSupervisorID: z.string().optional(),
    inboxID: z.string(),
    type: z.string(),
  }),
)

export const RegisteredDurable = EventV2.define({
  type: "supervisor.registered",
  durable: { aggregate: "session_id", version: 1 },
  schema: {
    session_id: Schema.String,
    supervisor_id: Schema.String,
    mode: Schema.Literals(["peer", "subagent", "main"]),
    lifecycle: Schema.Literals(["ephemeral", "persistent"]),
    agent: Schema.String,
    parent_supervisor_id: Schema.optional(Schema.String),
  },
})

export const UpdatedDurable = EventV2.define({
  type: "supervisor.updated",
  durable: { aggregate: "session_id", version: 1 },
  schema: {
    session_id: Schema.String,
    supervisor_id: Schema.String,
    status: Schema.Literals(["pending", "running", "idle"]),
    last_outcome: Schema.optional(Schema.Literals(["success", "failure", "cancelled"])),
  },
})

export const AdmittedDurable = EventV2.define({
  type: "supervisor.admitted",
  durable: { aggregate: "session_id", version: 1 },
  schema: {
    session_id: Schema.String,
    supervisor_id: Schema.String,
    peer_supervisor_id: Schema.String,
    proof: Schema.String,
  },
})

export const AgentLineageAdmissionV1 = BusEvent.define(
  "agent.lineage_admission.v1",
  z.object({
    sessionID: SessionID.zod,
    supervisorID: z.string(),
    peerSupervisorID: z.string(),
    proof: z.string(),
  }),
)
