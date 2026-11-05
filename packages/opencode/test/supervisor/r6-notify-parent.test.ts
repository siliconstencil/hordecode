// R6-1 item 6: `notifyParentOnComplete` was passed by the inbox wake and read by nobody.
// The parameter was removed; this test pins that it stays gone.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs"
import path from "node:path"
import { Inbox } from "@opencode-ai/inbox"
import { sessionPromptRef } from "@opencode-ai/inbox/inbox-ref"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { allowAll, it, useServerConfig } from "./r6-harness"
import { has } from "./r6-helpers"

const packages = path.join(import.meta.dir, "../../..")

// Every source file under packages/*/src that mentions the name, with the matching lines.
const mentions = () =>
  fs
    .readdirSync(packages)
    .flatMap((pkg) => {
      const src = path.join(packages, pkg, "src")
      if (!fs.existsSync(src)) return []
      return (fs.readdirSync(src, { recursive: true }) as string[])
        .filter((f) => /\.(ts|tsx)$/.test(f))
        .flatMap((f) =>
          fs
            .readFileSync(path.join(src, f), "utf8")
            .split("\n")
            .flatMap((line, i) => (line.includes("notifyParentOnComplete") ? [{ file: `${pkg}/src/${f}`, line: i + 1, text: line.trim() }] : [])),
        )
    })

describe("notifyParentOnComplete (R6-1 item 6)", () => {
  test("the name appears nowhere in package sources", () => {
    const found = mentions()
    expect(found.map((m) => m.file)).toEqual([])
  })

  it.instance(
    "the inbox wake asks the loop to run without the removed parameter",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const inbox = yield* Inbox.Service
        const chat = yield* sessions.create({ title: "R6 notify parent", permission: allowAll })
        const seen: Record<string, unknown>[] = []
        const real = sessionPromptRef.current!
        sessionPromptRef.current = {
          ...real,
          loop: (input: Parameters<typeof real.loop>[0]) => {
            seen.push({ ...input })
            return real.loop(input)
          },
        }
        try {
          let release: (value?: unknown) => void = () => {}
          const gate = new Promise((resolve) => (release = resolve))
          yield* llm.hold("FIRST-REPLY", gate)
          yield* llm.textMatch((hit) => has(hit, "NOTIFY-PING"), "reply to the ping")
          const turn = yield* prompt
            .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "go" }] })
            .pipe(Effect.forkScoped({ startImmediately: true }))
          yield* llm.wait(1)
          yield* inbox.send({
            receiverSessionID: chat.id,
            receiverSupervisorID: "main",
            senderSessionID: SessionID.make("ses_r6_notify"),
            senderSupervisorID: "worker-1",
            content: "NOTIFY-PING",
          })
          release()
          yield* Fiber.join(turn)
        } finally {
          sessionPromptRef.current = real
        }
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ sessionID: chat.id, agentID: "main" })
        expect(seen[0]).not.toHaveProperty("notifyParentOnComplete")
        // The real loop's input type has no such field, so nothing downstream can have read it.
        const loopInputKeys = fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt.ts"), "utf8")
        expect(loopInputKeys).not.toContain("notifyParentOnComplete")
      }),
    40_000,
  )
})
