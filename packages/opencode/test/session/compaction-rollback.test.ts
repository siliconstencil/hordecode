import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// A compaction boundary is a user message with a compaction part. MessageV2.filterCompacted treats a
// boundary whose summary finished without error as authoritative and drops everything before it. When
// the summary does not land (the model returns no text, or the compaction overflows), the boundary must
// not stay behind: with an empty summary it erases the history and contributes nothing in its place.
// MiMo Code e743bbe4 (packages/cli/src/session/compaction.ts:453-483 at v0.1.16) rolls it back.

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}
const basicUsage = () => new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

function model() {
  return ProviderTest.fake({
    model: {
      id: "test-model",
      providerID: "test",
      name: "Test",
      limit: { context: 100_000, output: 32_000 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: {
        toolcall: true,
        attachment: false,
        reasoning: false,
        temperature: true,
        input: { text: true, image: false, audio: false, video: false },
        output: { text: true, image: false, audio: false, video: false },
      },
      api: { npm: "@ai-sdk/anthropic" },
      options: {},
    } as Provider.Model,
  })
}

const overflowProcessor = Layer.succeed(
  SessionProcessorModule.SessionProcessor.Service,
  SessionProcessorModule.SessionProcessor.Service.of({
    create: Effect.fn("TestSessionProcessor.create")((input) =>
      Effect.succeed({
        get message() {
          return input.assistantMessage
        },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
        process: () => Effect.succeed("compact" as const),
        replay: () => Effect.succeed("compact" as const),
      } satisfies SessionProcessorModule.SessionProcessor.Handle),
    ),
  }),
)

const node = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const base = [
  [Provider.node, model().layer],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [SessionSummary.node, summaryStub],
] as const

const withText = (text: string) =>
  Effect.provide(
    AppNodeBuilder.build(node, [
      ...base,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream: () =>
              Stream.make(
                ...(text
                  ? [
                      LLMEvent.textStart({ id: "txt-0" }),
                      LLMEvent.textDelta({ id: "txt-0", text }),
                      LLMEvent.textEnd({ id: "txt-0" }),
                    ]
                  : []),
                LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
                LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
              ),
          }),
        ),
      ],
    ]),
  )

const withOverflow = Effect.provide(
  AppNodeBuilder.build(node, [...base, [SessionProcessorModule.SessionProcessor.node, overflowProcessor]]),
)

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node])))

const user = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
    return msg
  })

/** A session with two earlier turns and a freshly created compaction boundary; returns the ids. */
const setup = Effect.gen(function* () {
  const ssn = yield* SessionNs.Service
  const session = yield* ssn.create({})
  const first = yield* user(session.id, "the task: migrate the billing module")
  const second = yield* user(session.id, "second turn")
  yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
  const msgs = yield* ssn.messages({ sessionID: session.id })
  const boundary = msgs.at(-1)!.info.id
  return { ssn, session, first, second, boundary, msgs }
})

const visible = (sessionID: SessionID) =>
  MessageV2.filterCompactedEffect(sessionID).pipe(Effect.map((msgs) => msgs.map((m) => m.info.id)))

describe("compaction boundary when no summary lands", () => {
  it.instance("a successful summary keeps the boundary and cuts the history before it (control)", () =>
    Effect.gen(function* () {
      const { session, first, second, boundary, msgs } = yield* setup
      const result = yield* SessionCompaction.use.process({ parentID: boundary, messages: msgs, sessionID: session.id, auto: false })
      expect(result).toBe("continue")
      const ids = yield* visible(session.id)
      expect(ids).toContain(boundary)
      expect(ids).not.toContain(first.id)
      expect(ids).not.toContain(second.id)
    }).pipe(withText("Summary: migrating the billing module, step 1 done.")),
  )

  it.instance("an empty summary does not erase the history: the boundary is rolled back and the compaction stops", () =>
    Effect.gen(function* () {
      const { ssn, session, first, second, boundary, msgs } = yield* setup
      const result = yield* SessionCompaction.use.process({ parentID: boundary, messages: msgs, sessionID: session.id, auto: false })

      const ids = yield* visible(session.id)
      expect(ids).toContain(first.id)
      expect(ids).toContain(second.id)
      expect(ids).not.toContain(boundary)
      expect(result).toBe("stop")
      const summary = (yield* ssn.messages({ sessionID: session.id })).find((m) => m.info.role === "assistant" && m.info.summary)
      expect(summary?.info.role === "assistant" ? JSON.stringify(summary.info.error) : "").toContain("no usable summary")
    }).pipe(withText("")),
  )

  it.instance("an overflowing compaction removes its boundary and keeps the overflow error", () =>
    Effect.gen(function* () {
      const { ssn, session, first, second, boundary, msgs } = yield* setup
      const result = yield* SessionCompaction.use.process({ parentID: boundary, messages: msgs, sessionID: session.id, auto: false })

      expect(result).toBe("stop")
      const all = yield* ssn.messages({ sessionID: session.id })
      expect(all.map((m) => m.info.id)).not.toContain(boundary)
      expect(all.map((m) => m.info.id)).toContain(first.id)
      expect(all.map((m) => m.info.id)).toContain(second.id)
      const summary = all.find((m) => m.info.role === "assistant" && m.info.summary)
      expect(JSON.stringify(summary?.info.role === "assistant" ? summary.info.error : "")).toContain("too large to compact")
    }).pipe(withOverflow),
  )
})
