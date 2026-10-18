// The session tool reads a subagent child's supervisor row with listBySession, because a
// subagent row is keyed (child session, "<agent>-N") and not (child session, child session).
// status must return that row; the dashboard must not list a subagent child as a peer.
// The registry mock keeps the real primary-key semantics (session_id, supervisor_id).
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import type { Supervisor } from "@opencode-ai/supervisor"
import { Inbox } from "@opencode-ai/inbox"
import { Session } from "../../src/session/session"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { SessionTool } from "../../src/tool/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Bus } from "@opencode-ai/bus"
import { Worktree } from "../../src/worktree"
import type { Context } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const CHILD = SessionID.make("ses-child")

// One subagent row, keyed the way spawnSubagent registers it: (child session, "general-1").
const rows: Supervisor[] = [
  {
    sessionID: CHILD,
    supervisorID: "general-1",
    mode: "subagent",
    status: "idle",
    lastOutcome: "success",
    lifecycle: "ephemeral",
    agent: "general",
    description: "subagent child",
    contextMode: "none",
    background: false,
    lastTurnTime: 0,
    turnCount: 1,
    time: { created: 0, updated: 0 },
  } as unknown as Supervisor,
]

const layer = Layer.mergeAll(
  Layer.mock(Bus.Service, {
    publish: () => Effect.void,
    subscribe: () => {
      throw new Error("subscribe not used in test")
    },
    subscribeAll: () => {
      throw new Error("subscribeAll not used in test")
    },
    subscribeCallback: () => Effect.succeed(() => {}),
    subscribeAllCallback: () => Effect.succeed(() => {}),
  }),
  Layer.mock(SupervisorRegistryService.Service, {
    get: (sessionID: SessionID, supervisorID: string) =>
      Effect.succeed(rows.find((row) => row.sessionID === sessionID && row.supervisorID === supervisorID)),
    listBySession: (sessionID: SessionID) => Effect.succeed(rows.filter((row) => row.sessionID === sessionID)),
  }),
  Layer.mock(Inbox.Service, {}),
  Layer.mock(Session.Service, {
    messages: () => Effect.succeed([]),
    get: () => Effect.succeed({ id: CHILD, directory: "/tmp/session-tool-subagent" } as unknown as Session.Info),
  } as unknown as Session.Interface),
  Layer.mock(Provider.Service, {}),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "main" } as unknown as Agent.Info),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  }),
  Layer.mock(Worktree.Service, {} as unknown as Worktree.Interface),
)

const it = testEffect(layer)

const ctx: Context = {
  sessionID: SessionID.make("ses-parent"),
  messageID: MessageID.ascending(),
  agent: "main",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("session tool subagent rows", () => {
  it.live("status reports a subagent child's registry row instead of unknown", () =>
    Effect.gen(function* () {
      const info = yield* SessionTool
      const def = yield* info.init()
      const result = yield* def.execute({ operation: { action: "status", sessionID: CHILD } } as never, ctx)
      const parsed = JSON.parse(result.output) as { status: string; lastOutcome?: string }
      expect(parsed.status).not.toBe("unknown")
      expect(parsed.status).toBe("idle")
      expect(parsed.lastOutcome).toBe("success")
    }),
  )
})
