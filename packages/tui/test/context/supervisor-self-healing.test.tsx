/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { json, mount, wait } from "../cli/cmd/tui/sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

const sessionID = "ses_supervisor_stale_test"

function supervisorEvent(
  type: "supervisor.registered" | "supervisor.status" | "supervisor.stuck",
  properties: Record<string, unknown>,
): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    payload: {
      id: `evt_${type}_${properties.supervisorID}`,
      type,
      properties: { sessionID, ...properties },
    } as unknown as GlobalEvent["payload"],
  }
}

function sessionUpdatedEvent(sid: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    payload: {
      id: "evt_session_init",
      type: "session.updated",
      sessionID: sid,
      properties: {
        info: {
          id: sid,
          title: "test",
          time: { created: 0, updated: 0 },
          version: "1.15.13",
          directory: "/tmp/opencode/packages/opencode",
          slug: "test",
          projectID: "proj_test",
        },
      },
    } as unknown as GlobalEvent["payload"],
  }
}

function sessionFetchHandler(url: URL) {
  if (url.pathname === `/session/${sessionID}`)
    return json({
      id: sessionID,
      title: "test",
      time: { created: 0, updated: 0 },
      version: "1.15.13",
      directory: "/tmp/opencode/packages/opencode",
      slug: "test",
      projectID: "proj_test",
    })
  if (url.pathname === `/session/${sessionID}/message`) return json([])
  if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
  if (url.pathname === `/session/${sessionID}/supervisor`) return json([])
  return undefined
}

describe("supervisor SSE self-healing", () => {
  test("supervisor.status for unknown supervisor_id inserts best-effort entry", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(sessionFetchHandler, tmp.path)

    try {
      emit(sessionUpdatedEvent(sessionID))
      await wait(() => sync.data.session.length > 0)

      expect(sync.data.supervisor[sessionID]).toBeUndefined()

      const unknownID = "sup_unknown_123"
      emit(supervisorEvent("supervisor.status", { supervisorID: unknownID, status: "running" }))
      await wait(() => (sync.data.supervisor[sessionID]?.length ?? 0) > 0)

      const list = sync.data.supervisor[sessionID]
      expect(list).toBeDefined()
      expect(list!.length).toBe(1)
      expect(list![0].supervisor_id).toBe(unknownID)
      expect(list![0].status).toBe("running")
      expect(list![0].agent).toBe("unknown")
      expect(list![0].description).toBe("")
    } finally {
      app.renderer.destroy()
    }
  })

  test("supervisor.status for known supervisor_id updates existing entry", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(sessionFetchHandler, tmp.path)

    try {
      emit(sessionUpdatedEvent(sessionID))
      await wait(() => sync.data.session.length > 0)

      const knownID = "sup_known_456"
      emit(
        supervisorEvent("supervisor.registered", {
          supervisorID: knownID,
          mode: "subagent",
          agent: "build",
          description: "test task",
        }),
      )
      await wait(() => (sync.data.supervisor[sessionID]?.length ?? 0) > 0)
      expect(sync.data.supervisor[sessionID]![0].status).toBe("pending")

      emit(supervisorEvent("supervisor.status", { supervisorID: knownID, status: "idle", lastOutcome: "success" }))
      await wait(() => sync.data.supervisor[sessionID]![0].status === "completed")
      expect(sync.data.supervisor[sessionID]![0].status).toBe("completed")
    } finally {
      app.renderer.destroy()
    }
  })

  test("supervisor.stuck for unknown supervisor_id inserts best-effort entry", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(sessionFetchHandler, tmp.path)

    try {
      emit(sessionUpdatedEvent(sessionID))
      await wait(() => sync.data.session.length > 0)

      const unknownID = "sup_stuck_789"
      emit(supervisorEvent("supervisor.stuck", { supervisorID: unknownID, stuckDuration: 5000 }))
      await wait(() => (sync.data.supervisor[sessionID]?.length ?? 0) > 0)

      const list = sync.data.supervisor[sessionID]
      expect(list).toBeDefined()
      expect(list!.length).toBe(1)
      expect(list![0].supervisor_id).toBe(unknownID)
      expect(list![0].status).toBe("stuck")
    } finally {
      app.renderer.destroy()
    }
  })
})
