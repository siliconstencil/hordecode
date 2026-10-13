import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { joinGroup, type JoinDeps } from "../src/group"
import type { Supervisor } from "../src/schema"
import type { SessionID } from "@opencode-ai/core/session/schema"

// A join that times out must report members that still have a registry row
// as "running" (with their live status), and only members without a row as
// "unknown". Before this test the timeout branch labelled both "unknown", and
// the session tool printed "unknown (no registered supervisor)" for children
// that were merely still working.
function deps(rows: Record<string, Partial<Supervisor>>): JoinDeps {
  return {
    reg: {
      get: (sessionID: string, supervisorID: string) =>
        Effect.succeed(rows[`${sessionID}:${supervisorID}`] as Supervisor | undefined),
    } as unknown as JoinDeps["reg"],
    sessions: { messages: () => Effect.succeed([]) },
    bus: { subscribeCallback: () => Effect.succeed(() => {}) } as unknown as JoinDeps["bus"],
  }
}

describe("joinGroup timeout outcomes", () => {
  test("running row -> running, missing row -> unknown, idle success -> success", async () => {
    const sid = "ses_a" as SessionID
    const d = deps({
      "ses_a:running-1": { supervisorID: "running-1", status: "running", turnCount: 3, description: "worker" },
      "ses_a:done-1": { supervisorID: "done-1", status: "idle", lastOutcome: "success", turnCount: 2 },
    })
    const result = await Effect.runPromise(
      joinGroup(d, {
        members: [
          { sessionID: sid, supervisorID: "running-1" },
          { sessionID: sid, supervisorID: "done-1" },
          { sessionID: sid, supervisorID: "ghost" },
        ],
        timeout_ms: 20,
      }),
    )
    expect(result.status).toBe("timeout")
    expect(result.counts).toEqual({ success: 1, failure: 0, cancelled: 0, running: 1, unknown: 1 })
    const running = result.members.find((m) => m.supervisorID === "running-1")!
    expect(running.outcome).toBe("running")
    expect(running.status).toBe("running")
    expect(running.turnCount).toBe(3)
    expect(result.members.find((m) => m.supervisorID === "ghost")!.outcome).toBe("unknown")
  })
})
