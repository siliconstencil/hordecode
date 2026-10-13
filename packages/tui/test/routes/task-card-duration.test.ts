import { expect, test } from "bun:test"
import type { GlobalEvent, Message, Part } from "@opencode-ai/sdk/v2"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { selectMessages } from "../../src/context/sync"
import { formatCompletedSubagentDetail } from "../../src/routes/session"
import { Locale } from "../../src/util/locale"
import { tmpdir } from "../fixture/fixture"
import { mount, wait } from "../cli/cmd/tui/sync-fixture"

/**
 * a completed subagent card rendered "0ms" instead of
 * the child session's real duration.
 *
 * fork buckets the message store by agentID (context/sync.tsx:96-104, and the
 * message.updated arm at :688 keys the bucket by `info.agentID ?? "main"`), so a
 * subagent's turns land in a bucket named after the subagent, never in "main".
 * The card read the raw "main" bucket (routes/session/index.tsx:3218), so for a
 * child session messages() was empty -> tools() empty and duration() returned
 * its 0 fallback (:3269-3274) -> the card rendered "0ms" with no toolcall count
 * (:3342).
 *
 * The canonical selector for this store is selectMessages
 * (context/sync.tsx:106-118), which the session route itself already uses for
 * the conversation (:260) and for the export path (:976).
 */

const childID = "ses_task_card_child"
const childAgentID = "explore"

// The card reads the child session the task tool call points at, so the fixture
// buckets both of the child's messages under the subagent's own agentID.
const childMessages: Message[] = [
  {
    id: "msg_task_card_user",
    sessionID: childID,
    agentID: childAgentID,
    role: "user",
    time: { created: 1_000 },
  } as unknown as Message,
  {
    id: "msg_task_card_assistant",
    sessionID: childID,
    agentID: childAgentID,
    role: "assistant",
    time: { created: 1_100, completed: 1_600 },
  } as unknown as Message,
]

// Two tool parts inside the child's assistant turn: they are both the toolcall
// counter and the reason the pre-fix card degraded to duration-only copy.
const childParts: Part[] = ["prt_task_card_read", "prt_task_card_grep"].map(
  (id) =>
    ({
      id,
      sessionID: childID,
      messageID: "msg_task_card_assistant",
      type: "tool",
      tool: "read",
      state: { status: "completed" },
    }) as unknown as Part,
)

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function emitMessage(emit: Awaited<ReturnType<typeof mount>>["emit"], info: Message) {
  emit(
    global({
      id: `evt_${info.id}`,
      type: "message.updated",
      properties: { sessionID: info.sessionID, info },
    } as unknown as GlobalEvent["payload"]),
  )
}

// Mirrors the card's own derivation for one message set: the toolcall count of
// its tool parts (:3220-3226) and the distance between the first user message
// and the last completed assistant message (:3269-3274), formatted by the
// exported helper the card calls at :3342.
function cardDetail(messages: Message[], parts: Record<string, Part[]>) {
  const toolcalls = messages.flatMap((message) => parts[message.id] ?? []).filter((part) => part.type === "tool").length
  const first = messages.find((message) => message.role === "user")?.time.created
  const assistant = messages.findLast((message) => message.role === "assistant")?.time.completed
  const elapsed = !first || !assistant ? 0 : assistant - first
  return formatCompletedSubagentDetail(toolcalls, Locale.duration(elapsed))
}

test("the subagent card reads the child session's messages from their own bucket", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    for (const info of childMessages) emitMessage(emit, info)
    for (const part of childParts) {
      emit(
        global({
          id: `evt_${part.id}`,
          type: "message.part.updated",
          properties: { part },
        } as unknown as GlobalEvent["payload"]),
      )
    }

    await wait(() => sync.data.message[childID]?.[childAgentID]?.length === 2)
    await wait(() => (sync.data.part["msg_task_card_assistant"] ?? []).length === 2)

    // The store really did bucket the child's turn away from "main": this is
    // the read the card used to perform (:3218), and it is empty.
    const preFixMessages = sync.data.message[childID]?.["main"] ?? []
    expect(preFixMessages).toEqual([])
    // Empty messages -> no toolcalls and the duration fallback -> "0ms", the
    // reported symptom, produced by the card's own formatter.
    expect(cardDetail(preFixMessages, sync.data.part)).toBe("0ms")

    // The canonical selector returns the child's own bucket, so the card now
    // reports the real toolcalls and the real elapsed time.
    const messages = selectMessages(sync.data.message[childID], "main", childID)
    expect(messages.map((message) => message.id)).toEqual(["msg_task_card_user", "msg_task_card_assistant"])
    expect(cardDetail(messages, sync.data.part)).toBe("2 toolcalls · 600ms")
  } finally {
    app.renderer.destroy()
  }
})

// The card must keep reading through the selector: the raw bucket read above is
// exactly what regressed, and it is a silent 0 rather than a crash.
test("the task card memo reads the child session through selectMessages", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "routes", "session", "index.tsx"), "utf-8")
  expect(source).toContain('selectMessages(sync.data.message[sessionID() ?? ""], "main", sessionID() ?? "")')
  expect(source).not.toContain('sync.data.message[sessionID() ?? ""]?.["main"]')
})
