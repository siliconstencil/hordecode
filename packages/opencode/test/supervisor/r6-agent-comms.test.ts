// Round 6, slice 1: agent communication through the real loop. Real SessionPrompt, Supervisor, Inbox, registry and
// SQLite, with the scripted LLM server. Each scenario has a revert-the-feature counterpart recorded in
// reports/rnd/rnd-r6-agents-tests.md.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/storage"
import { Inbox } from "@opencode-ai/inbox"
import { InboxTable } from "@opencode-ai/inbox/inbox.sql"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { allowAll, it, useServerConfig } from "./r6-harness"
import { has, lastRole, waitFor } from "./r6-helpers"

const inboxRows = (sessionID: string) =>
  Database.use((db) => db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID as SessionID)).all())

const textOf = (m: { parts: { type: string; text?: string }[] }) =>
  m.parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n")

// A parent starts one background child; the child answers; nobody prompts the parent again.
const background = Effect.gen(function* () {
  const { llm } = yield* useServerConfig()
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "R6 parent", permission: allowAll })
  yield* llm.toolMatch(
    (hit) => has(hit, "PARENT-GO") && lastRole(hit) === "user" && !has(hit, "CHILD-TASK"),
    "supervisor",
    { operation: { action: "spawn", subagent_type: "general", description: "bg child", prompt: "CHILD-TASK do it" } },
  )
  yield* llm.textMatch((hit) => has(hit, "CHILD-TASK") && !has(hit, "PARENT-GO"), "CHILD-RESULT-XYZ done\n\n**Status**: success\n**Summary**: child did it")
  yield* llm.textMatch((hit) => has(hit, "PARENT-GO") && lastRole(hit) === "tool", "parent ack spawned")
  yield* llm.textMatch((hit) => has(hit, "supervisor-notification"), "parent saw the notification")
  yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "PARENT-GO" }] })
  const finalReply = yield* waitFor(
    "the parent's reply to the notification",
    sessions.messages({ sessionID: chat.id }).pipe(
      Effect.map((msgs) => msgs.findLast((m) => m.info.role === "assistant" && textOf(m).includes("parent saw the notification"))),
    ),
  )
  return { chat, sessions, llm, finalReply }
})

describe("background completion reaches the parent (R6-1 item 2)", () => {
  it.instance(
    "the child's result arrives in the parent's conversation as a supervisor notification",
    () =>
      Effect.gen(function* () {
        const { chat, sessions, llm } = yield* background
        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const notification = msgs.find((m) => m.info.role === "user" && textOf(m).includes("<supervisor-notification>"))
        expect(notification).toBeDefined()
        expect(textOf(notification!)).toContain("CHILD-RESULT-XYZ")
        expect(textOf(notification!)).toContain("bg child")
        expect(textOf(notification!)).toContain("completed")
        // the parent model saw it: a request that carries the notification and the child's text
        const inputs = yield* llm.inputs
        expect(inputs.some((b) => has({ body: b }, "<supervisor-notification>") && has({ body: b }, "CHILD-RESULT-XYZ"))).toBe(true)
        // and the row was consumed
        expect(inboxRows(chat.id)).toHaveLength(0)
      }),
    40_000,
  )
})

describe("a finished background child wakes its parent (R6-1 item 3)", () => {
  it.instance(
    "actual behavior: the parent runs another turn with no new user prompt",
    () =>
      Effect.gen(function* () {
        const { chat, sessions, llm } = yield* background
        const msgs = yield* sessions.messages({ sessionID: chat.id })
        // exactly one real user prompt was ever sent; every later parent turn was started by the notification
        const realUserTurns = msgs.filter((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "text" && "synthetic" in p && p.synthetic === true))
        expect(realUserTurns).toHaveLength(1)
        const parentCalls = (yield* llm.inputs).filter((b) => has({ body: b }, "PARENT-GO"))
        expect(parentCalls.length).toBe(3)
        expect(msgs.filter((m) => m.info.role === "assistant").length).toBeGreaterThanOrEqual(3)
      }),
    40_000,
  )

  // OPEN DECISION: packages/opencode/src/tool/supervisor.txt tells the model the parent is NOT woken; the code
  // (packages/inbox/src/inbox.ts:151-153) always wakes it. The test above pins the code. This one pins the doc and is
  // expected to fail until the owner picks which side changes.
  test.failing("supervisor.txt describes the behavior the code has (it says there is no auto-wake)", () => {
    const doc = fs.readFileSync(path.join(import.meta.dir, "../../src/tool/supervisor.txt"), "utf8")
    expect(doc).not.toContain("does NOT auto-wake")
  })
})

describe("inbox delivery through the real loop (R6-1 item 1)", () => {
  it.instance(
    "a message sent to a busy receiver is drained into its next turn",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const inbox = yield* Inbox.Service
        const chat = yield* sessions.create({ title: "R6 busy receiver", permission: allowAll })
        let release: (value?: unknown) => void = () => {}
        const gate = new Promise((resolve) => (release = resolve))
        yield* llm.hold("FIRST-REPLY", gate)
        yield* llm.textMatch((hit) => has(hit, "PING-FROM-PEER"), "second reply that saw the ping")

        const turn = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "start working" }] })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* llm.wait(1)
        // the receiver is mid-turn (its model reply is held): this is the "busy" send
        const sent = yield* inbox.send({
          receiverSessionID: chat.id,
          receiverSupervisorID: "main",
          senderSessionID: SessionID.make("ses_r6_sender"),
          senderSupervisorID: "worker-1",
          content: "PING-FROM-PEER please look at this",
        })
        expect(sent.inboxID).toBeTruthy()
        release()
        yield* Fiber.join(turn)

        const second = yield* waitFor(
          "a model request that carries the ping",
          llm.inputs.pipe(Effect.map((all) => all.find((b) => has({ body: b }, "PING-FROM-PEER")))),
        )
        expect(lastRole({ body: second })).toBe("user")
        const msgs = yield* waitFor(
          "the synthetic inbox message in the session",
          sessions.messages({ sessionID: chat.id }).pipe(
            Effect.map((all) => (all.some((m) => textOf(m).includes("PING-FROM-PEER")) ? all : undefined)),
          ),
        )
        const delivered = msgs.find((m) => m.info.role === "user" && textOf(m).includes("PING-FROM-PEER"))!
        expect(textOf(delivered)).toContain('<inbox from="ses_r6_sender:worker-1"')
        expect(inboxRows(chat.id)).toHaveLength(0)
      }),
    40_000,
  )
})
