// Integration test for the wake silence scan (wake.ts `scan`). It runs with the
// Effect TestClock, so the 60 s scan cadence and the 15-minute idle window are
// simulated: the fixture backdates the last assistant message and the test
// advances the clock instead of sleeping. Only the parent's own open task and
// assistant activity are seeded; no child terminal event fires, so the only
// possible wake comes from the scan.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { MessageID } from "@opencode-ai/core/session/schema"
import { TaskTable } from "@opencode-ai/task/task.sql"
import { Session } from "@/session/session"
import { SessionWake } from "../../src/session/wake"
import { withTmpdirInstance } from "../fixture/fixture"
import { allowAll, it } from "../supervisor/supervisor-test-harness"

const wakeParts = (messages: Array<{ parts: Array<{ type: string; text?: string }> }>) =>
  messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.startsWith("Wake: ")),
  )

const pollWake = (sessions: Session.Interface, parentID: string, turns: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < turns; i++) {
      yield* TestClock.adjust("1 second")
      const messages = yield* sessions.messages({ sessionID: parentID as never }).pipe(Effect.orDie)
      const wake = wakeParts(messages)[0]
      if (wake) return wake
    }
    return undefined
  })

describe("session wake silence scan", () => {
  it.effect(
    "wakes a parent after 15 minutes of silence with an open task",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const db = (yield* Database.Service).db
        const wakeService = yield* SessionWake.Service
        const id = Math.random().toString(36).slice(2, 10)
        const lastActivity = Date.now() - 16 * 60_000
        const parent = yield* sessions.create({ title: "Scan parent", permission: allowAll })
        yield* sessions.create({ title: "Scan child", parentID: parent.id, permission: allowAll })
        yield* db
          .insert(MessageTable)
          .values({
            id: MessageID.make(`msg_scan_${id}`),
            session_id: parent.id,
            agent_id: "main",
            time_created: lastActivity,
            time_updated: lastActivity,
            data: {
              role: "assistant",
              agent: "build",
              providerID: "test",
              modelID: "test-model",
              time: { created: lastActivity },
            } as never,
          })
          .run()
        yield* db
          .insert(TaskTable)
          .values({
            id: `task_scan_${id}`,
            session_id: parent.id,
            status: "open",
            summary: "waiting on the child",
            created_at: lastActivity,
            last_event_at: lastActivity,
          })
          .run()

        yield* wakeService.init()
        const wake = yield* pollWake(sessions, parent.id, 120)

        expect(wake?.text).toContain("Wake:")
        expect(wake?.text).toContain("tasks are still open")
      }).pipe(withTmpdirInstance()),
    30_000,
  )

  it.effect(
    "does not wake a parent below the 15-minute threshold",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const db = (yield* Database.Service).db
        const wakeService = yield* SessionWake.Service
        const id = Math.random().toString(36).slice(2, 10)
        const lastActivity = Date.now() - 60_000
        const parent = yield* sessions.create({ title: "Fresh parent", permission: allowAll })
        yield* sessions.create({ title: "Fresh child", parentID: parent.id, permission: allowAll })
        yield* db
          .insert(MessageTable)
          .values({
            id: MessageID.make(`msg_scan_${id}`),
            session_id: parent.id,
            agent_id: "main",
            time_created: lastActivity,
            time_updated: lastActivity,
            data: {
              role: "assistant",
              agent: "build",
              providerID: "test",
              modelID: "test-model",
              time: { created: lastActivity },
            } as never,
          })
          .run()
        yield* db
          .insert(TaskTable)
          .values({
            id: `task_scan_${id}`,
            session_id: parent.id,
            status: "open",
            summary: "just started",
            created_at: lastActivity,
            last_event_at: lastActivity,
          })
          .run()

        yield* wakeService.init()
        const wake = yield* pollWake(sessions, parent.id, 120)

        expect(wake).toBeUndefined()
      }).pipe(withTmpdirInstance()),
    30_000,
  )
})
