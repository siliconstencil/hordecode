// R6-1 item 6: `notifyParentOnComplete` is passed by the inbox wake and read by nobody.
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
  test("the name appears only where it is written: the wake call and the ref type, never as a read", () => {
    const found = mentions()
    expect(found.map((m) => m.file).sort()).toEqual(["inbox/src/inbox-ref.ts", "inbox/src/inbox.ts"])
    // a read would be a property access on an input or a destructuring of it
    expect(found.filter((m) => /\.notifyParentOnComplete|\{[^}]*notifyParentOnComplete[^}]*\}\s*=/.test(m.text))).toEqual([])
  })

  it.instance(
    "the inbox wake passes it to the loop, and the loop's behavior does not depend on it",
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
        expect(seen[0]).toMatchObject({ sessionID: chat.id, agentID: "main", notifyParentOnComplete: true })
        // The real loop's input type has no such field, so nothing downstream can have read it.
        const loopInputKeys = fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt.ts"), "utf8")
        expect(loopInputKeys).not.toContain("notifyParentOnComplete")
      }),
    40_000,
  )
})
