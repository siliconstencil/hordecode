/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { bucketMessages, selectMessages } from "../../../../src/context/sync"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

test("bucketMessages groups by agentID", () => {
  const msgs = [
    { id: "m1", agentID: "main" } as any,
    { id: "m2", agentID: "supervisor-1" } as any,
    { id: "m3", agentID: "supervisor-2" } as any,
    { id: "m4", agentID: null } as any,
    { id: "m5" } as any,
  ]
  const buckets = bucketMessages(msgs)
  expect(buckets["main"]).toHaveLength(3)
  expect(buckets["supervisor-1"]).toHaveLength(1)
  expect(buckets["supervisor-2"]).toHaveLength(1)
  expect(buckets["supervisor-1"][0].id).toBe("m2")
})

test("selectMessages returns direct agent bucket", () => {
  const buckets = {
    main: [{ id: "a1" }, { id: "a2" }] as any[],
    "supervisor-1": [{ id: "b1" }] as any[],
  }
  expect(selectMessages(buckets, "main", "ses_123")).toHaveLength(2)
  expect(selectMessages(buckets, "supervisor-1", "ses_123")).toHaveLength(1)
})

test("selectMessages fallback to self-session bucket for peer child", () => {
  const buckets = {
    "ses_123": [{ id: "peer_msg" }] as any[],
  }
  const result = selectMessages(buckets, "main", "ses_123")
  expect(result).toHaveLength(1)
  expect(result[0].id).toBe("peer_msg")
})

test("selectMessages fallback to newest non-main bucket for supervisor-id-keyed turns", () => {
  const buckets = {
    "build-1": [{ id: "z_last" }] as any[],
    "harness-1": [{ id: "a_first" }] as any[],
  }
  const result = selectMessages(buckets, "main", "ses_xyz")
  expect(result).toHaveLength(1)
  expect(result[0].id).toBe("z_last")
})

test("concurrent supervisors do not interleave - bucket isolation", () => {
  const parentSession = "ses_parent"
  const supervisorA = "supervisor-A"
  const supervisorB = "supervisor-B"
  const msgs = [
    { id: "m1", agentID: "main", sessionID: parentSession } as any,
    { id: "m2", agentID: supervisorA, sessionID: parentSession } as any,
    { id: "m3", agentID: supervisorB, sessionID: parentSession } as any,
    { id: "m4", agentID: supervisorA, sessionID: parentSession } as any,
    { id: "m5", agentID: supervisorB, sessionID: parentSession } as any,
  ]
  const buckets = bucketMessages(msgs)
  expect(buckets["main"]).toHaveLength(1)
  expect(buckets[supervisorA]).toHaveLength(2)
  expect(buckets[supervisorB]).toHaveLength(2)
  expect(selectMessages(buckets, supervisorA, parentSession).every((m) => (m as any).agentID === supervisorA)).toBe(true)
  expect(selectMessages(buckets, supervisorB, parentSession).every((m) => (m as any).agentID === supervisorB)).toBe(true)
  expect(selectMessages(buckets, "main", parentSession).every((m) => (m as any).agentID === "main")).toBe(true)
})

test("single supervisor regression - main bucket not empty returns main", () => {
  const buckets = {
    main: [{ id: "main_msg" }] as any[],
    "build-1": [{ id: "should_not_return" }] as any[],
  }
  const result = selectMessages(buckets, "main", "ses_123")
  expect(result[0].id).toBe("main_msg")
})

test("message.removed finds and removes middle message in bucket regardless of id order", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_bucket_removed"
  const { app, emit, sync } = await mount(undefined, tmp.path)
  function global(payload: GlobalEvent["payload"]): GlobalEvent {
    return { directory: "/tmp/other", project: "proj_test", payload }
  }
  try {
    const msgs = [
      { id: "msg_aaa", sessionID, agentID: "supervisor-1", role: "user" as const, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 10 } },
      { id: "msg_mmm", sessionID, agentID: "supervisor-1", role: "user" as const, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 20 } },
      { id: "msg_zzz", sessionID, agentID: "supervisor-1", role: "user" as const, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 30 } },
      { id: "msg_other", sessionID, agentID: "supervisor-2", role: "user" as const, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 15 } },
    ]
    for (const info of msgs) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } as any }))
    }
    await wait(() => sync.data.message[sessionID]?.["supervisor-1"]?.length === 3)
    expect(sync.data.message[sessionID]?.["supervisor-1"]?.map((m) => m.id)).toEqual(["msg_aaa", "msg_mmm", "msg_zzz"])
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID: "msg_mmm" } }))
    await wait(() => sync.data.message[sessionID]?.["supervisor-1"]?.length === 2)
    expect(sync.data.message[sessionID]?.["supervisor-1"]?.some((m) => m.id === "msg_mmm")).toBe(false)
    expect(sync.data.message[sessionID]?.["supervisor-1"]?.map((m) => m.id)).toEqual(["msg_aaa", "msg_zzz"])
    expect(sync.data.message[sessionID]?.["supervisor-2"]?.length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
