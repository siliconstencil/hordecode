// The child session title is the spawn description plus the agent marker that the
// TUI footer reads. The title is not cut from the task text, so a long task does
// not lose words.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { Session } from "@/session/session"
import { allowAll, it, useServerConfig } from "./supervisor-test-harness"

describe("child session title", () => {
  it.instance("title is the spawn description plus the agent marker", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const supervisor = yield* Supervisor.Service
      const chat = yield* sessions.create({ title: "Title parent", permission: allowAll })

      yield* llm.text("3")

      const task =
        "Count the .ts files directly inside the directory `a` (relative to project root /tmp/x). Not recursive. Report only the number."
      const spawned = yield* supervisor.spawn({
        mode: "subagent",
        sessionID: chat.id,
        agentType: "build",
        description: "Count .ts files in a",
        task,
        context: "none",
        tools: "INHERIT",
        background: true,
        steps: 40,
        lifecycle: "ephemeral",
      })

      const child = yield* sessions.get(spawned.sessionID)
      expect(child.title).toBe("Count .ts files in a (@build subagent)")
    }),
  )

  it.instance("title falls back to the agent type when there is no description", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const sessions = yield* Session.Service
      const supervisor = yield* Supervisor.Service
      const chat = yield* sessions.create({ title: "Title fallback parent", permission: allowAll })

      yield* llm.text("ok")

      const spawned = yield* supervisor.spawn({
        mode: "subagent",
        sessionID: chat.id,
        agentType: "build",
        task: "A short task",
        context: "none",
        tools: "INHERIT",
        background: true,
        steps: 40,
        lifecycle: "ephemeral",
      })

      const child = yield* sessions.get(spawned.sessionID)
      expect(child.title).toBe("build (@build subagent)")
    }),
  )
})
