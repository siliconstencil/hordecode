import { describe, expect, test } from "bun:test"
import {
  SupervisorRegistered,
  SupervisorStatusChanged,
  SupervisorStuck,
  InboxArrived,
  AgentLineageAdmissionV1,
} from "../src/events"

describe("supervisor bus events", () => {
  test("each event has the expected type and schema", () => {
    expect(SupervisorRegistered.type).toBe("supervisor.registered")
    expect(SupervisorStatusChanged.type).toBe("supervisor.status")
    expect(SupervisorStuck.type).toBe("supervisor.stuck")
    expect(InboxArrived.type).toBe("inbox.arrived")
    expect(AgentLineageAdmissionV1.type).toBe("agent.lineage_admission.v1")
  })

  test("SupervisorStuck validates a stuck payload", () => {
    const result = SupervisorStuck.properties.safeParse({
      sessionID: "ses_abc",
      supervisorID: "sv_1",
      description: "worker",
      lastTurnTime: 123,
      stuckDuration: 300_000,
    })
    expect(result.success).toBe(true)
  })

  test("SupervisorStuck rejects a missing stuckDuration", () => {
    const result = SupervisorStuck.properties.safeParse({
      sessionID: "ses_abc",
      supervisorID: "sv_1",
      description: "worker",
      lastTurnTime: 123,
    })
    expect(result.success).toBe(false)
  })

  test("SupervisorStatusChanged accepts the full payload with outcome", () => {
    const result = SupervisorStatusChanged.properties.safeParse({
      sessionID: "ses_abc",
      supervisorID: "sv_1",
      status: "idle",
      lastOutcome: "success",
      turnCount: 2,
      lastTurnTime: 456,
      error: undefined,
    })
    expect(result.success).toBe(true)
  })

  test("SupervisorRegistered accepts a full payload", () => {
    const result = SupervisorRegistered.properties.safeParse({
      sessionID: "ses_abc",
      supervisorID: "sv_1",
      mode: "subagent",
      parentSupervisorID: "sv_parent",
      description: "worker",
      agent: "general",
      background: false,
    })
    expect(result.success).toBe(true)
  })

  test("InboxArrived accepts a minimal payload", () => {
    const result = InboxArrived.properties.safeParse({
      receiverSessionID: "ses_abc",
      receiverSupervisorID: "main",
      inboxID: "inbox_1",
      type: "supervisor.stuck",
    })
    expect(result.success).toBe(true)
  })
})
