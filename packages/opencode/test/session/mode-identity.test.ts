import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { applyHarnessInjection } from "@opencode-ai/core/session/prompt"
import { SessionReminders } from "../../src/session/reminders"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Session } from "../../src/session/session"
import { MessageV2 } from "@opencode-ai/core/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { InstanceContext } from "@opencode-ai/project/instance"
import { testEffect } from "../lib/effect"

const SESSION_ID = SessionID.make("ses_test000000000001")
const MSG_ID_USER = MessageID.make("msg_test000000000001")
const MSG_ID_ASST = MessageID.make("msg_test000000000002")

function makeV2UserMsg(agent?: string): MessageV2.WithParts {
  return {
    info: {
      id: MSG_ID_USER,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: Date.now() },
      ...(agent ? { agent } : {}),
    } as MessageV2.User,
    parts: [
      {
        id: PartID.ascending(),
        messageID: MSG_ID_USER,
        sessionID: SESSION_ID,
        type: "text",
        text: "test user message",
      } as MessageV2.TextPart,
    ],
  }
}

function makeV1UserMsg(agent?: string): SessionV1.WithParts {
  return {
    info: {
      id: MSG_ID_USER,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: Date.now() },
      agent: agent ?? "test",
      model: {
        providerID: "test-provider" as any,
        modelID: "test-model" as any,
      },
    } as SessionV1.Info,
    parts: [
      {
        id: PartID.ascending(),
        messageID: MSG_ID_USER,
        sessionID: SESSION_ID,
        type: "text",
        text: "test user message",
      },
    ],
  }
}

function makeAssistantMsg(agent: string): SessionV1.WithParts {
  return {
    info: {
      id: MSG_ID_ASST,
      sessionID: SESSION_ID,
      role: "assistant",
      agent,
      modelID: "test-model" as any,
      providerID: "test-provider" as any,
      parentID: MSG_ID_USER,
      mode: agent,
      time: { created: Date.now() },
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: MSG_ID_ASST,
        sessionID: SESSION_ID,
        type: "text",
        text: "assistant response",
      },
    ],
  }
}

function makeAgent(overrides: Partial<Agent.Info> & { name: string }): Agent.Info {
  return {
    description: "test mode",
    mode: "primary" as const,
    permission: [],
    options: {},
    ...overrides,
  }
}

function makeCtx(): InstanceContext {
  return {
    directory: "/tmp/test-project",
    worktree: "/tmp/test-project",
    project: { name: "test", path: "/tmp/test-project" } as any,
  }
}

describe("applyHarnessInjection", () => {
  test("injects research prompt for research agent, not harness prompt", async () => {
    const msgs: MessageV2.WithParts[] = [makeV2UserMsg("research")]
    const agent = makeAgent({ name: "research", skillPipeline: "research" })
    const ctx = makeCtx()

    await Effect.runPromise(applyHarnessInjection(msgs, agent as any, {} as any, ctx))

    expect(msgs).toHaveLength(1)
    const firstPart = msgs[0].parts[0]
    expect(firstPart.type).toBe("text")
    if (firstPart.type !== "text") throw new Error("expected text part")

    const text = firstPart.text
    // Research-specific content must be present
    expect(text).toContain("Research Pipeline Sequence")
    expect(text).toContain("research:ask")
    // Harness-specific content must NOT be present
    expect(text).not.toContain("Pipeline Stage Sequence")
    expect(text).not.toContain("harness:plan")
    expect(text).not.toContain("## Simplicity")
  })

  test("does not inject when skillPipeline is absent", async () => {
    const msgs: MessageV2.WithParts[] = [makeV2UserMsg("build")]
    const agent = makeAgent({ name: "build" })
    const ctx = makeCtx()

    await Effect.runPromise(applyHarnessInjection(msgs, agent as any, {} as any, ctx))

    expect(msgs).toHaveLength(1)
    expect(msgs[0].parts).toHaveLength(1)
  })
})

describe("SessionReminders.apply", () => {
  const fsUtilStub = Layer.succeed(
    FSUtil.Service,
    FSUtil.Service.of({
      existsSafe: () => Effect.succeed(false),
      ensureDir: () => Effect.void,
    } as any),
  )

  const sessionStub = Layer.succeed(
    Session.Service,
    Session.Service.of({
      updatePart: (_input: any) => Effect.succeed({} as any),
    } as any),
  )

  const flags = RuntimeFlags.layer({ experimentalPlanMode: false })
  const testLayer = Layer.mergeAll(flags, fsUtilStub, sessionStub)
  const it = testEffect(testLayer)

  it.effect("injects mode-transition reminder when switching from harness to research", () =>
    Effect.gen(function* () {
      const messages: SessionV1.WithParts[] = [
        makeAssistantMsg("harness"),
        makeV1UserMsg("research"),
      ]
      const agent = makeAgent({
        name: "research",
        description: "Research mode for deep analysis",
        skillPipeline: "research",
      })
      const session = { id: SESSION_ID } as any

      const result = yield* SessionReminders.apply({ messages, agent, session })

      const userMsg = result.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      if (!userMsg) throw new Error("expected user message")

      const reminderPart = userMsg.parts.find(
        (p) => p.type === "text" && (p as any).synthetic && (p as any).text.includes("Mode switched"),
      )
      expect(reminderPart).toBeDefined()
      if (reminderPart?.type !== "text") throw new Error("expected text reminder part")

      expect(reminderPart.text).toContain("Mode switched to **research**")
      expect(reminderPart.text).toContain("Research mode for deep analysis")
      expect(reminderPart.text).toContain("`research:*`")
    }),
  )

  it.effect("does not inject reminder when previous agent matches current agent", () =>
    Effect.gen(function* () {
      const messages: SessionV1.WithParts[] = [
        makeAssistantMsg("research"),
        makeV1UserMsg("research"),
      ]
      const agent = makeAgent({
        name: "research",
        description: "Research mode for deep analysis",
        skillPipeline: "research",
      })
      const session = { id: SESSION_ID } as any

      const result = yield* SessionReminders.apply({ messages, agent, session })

      const userMsg = result.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      if (!userMsg) throw new Error("expected user message")

      const reminderPart = userMsg.parts.find(
        (p) => p.type === "text" && (p as any).synthetic && (p as any).text.includes("Mode switched"),
      )
      expect(reminderPart).toBeUndefined()
    }),
  )

  it.effect("injects harness skill namespace for harness mode", () =>
    Effect.gen(function* () {
      const messages: SessionV1.WithParts[] = [
        makeAssistantMsg("build"),
        makeV1UserMsg("harness"),
      ]
      const agent = makeAgent({
        name: "harness",
        description: "Harness mode for planning and execution",
        skillPipeline: "harness",
      })
      const session = { id: SESSION_ID } as any

      const result = yield* SessionReminders.apply({ messages, agent, session })

      const userMsg = result.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      if (!userMsg) throw new Error("expected user message")

      const reminderPart = userMsg.parts.find(
        (p) => p.type === "text" && (p as any).synthetic && (p as any).text.includes("Mode switched"),
      )
      expect(reminderPart).toBeDefined()
      if (reminderPart?.type !== "text") throw new Error("expected text reminder part")

      expect(reminderPart.text).toContain("Mode switched to **harness**")
      expect(reminderPart.text).toContain("`harness:*`")
    }),
  )
})
