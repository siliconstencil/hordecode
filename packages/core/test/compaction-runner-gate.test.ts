import { expect, test } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
// Prime the storage layer before the session graph so the circular-import TDZ in
// storage.ts:328 does not fire when this test loads under either compaction.ts version.
import { defaultLayer as _storageDefaultLayer } from "@opencode-ai/core/storage/storage"
void _storageDefaultLayer
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import type { EventV2 } from "@opencode-ai/core/event"
import { LLM, LLMEvent, Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"

const makeRunnerCompaction = (compactionInfo: ConfigCompaction.Info) =>
  SessionCompaction.make({
    events: { publish: () => Effect.void } as unknown as EventV2.Interface,
    llm: {
      stream: () => Stream.make(LLMEvent.textDelta({ id: "text-1", text: "summary" })),
    },
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({ compaction: compactionInfo }),
      }),
    ],
    hooks: { beforeCompact: () => Effect.void },
  })

test("runner compaction honors compaction.max_context and fires earlier than legacy window", () => {
  const model = Model.make({
    id: "fake-model",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 40_000, output: 4_000 } }),
  })
  const compaction = makeRunnerCompaction(new ConfigCompaction.Info({ buffer: 1_000, max_context: 15_000 }))
  // estimate(system+messages) ~14K tokens: between the configured usable window
  // (15K - ~8K reserve = ~7K) and the legacy raw window (40K - 4K = 36K).
  const request = LLM.request({
    model,
    system: "a".repeat(56_000),
    messages: [Message.user("hi")],
    tools: [],
  })
  const entries = [{ seq: 0, message: SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", time: { created: DateTime.makeUnsafe(new Date(0)) }, text: "x".repeat(40_000) }) }]
  const result = Effect.runSync(compaction.compactIfNeeded({ sessionID: "s" as SessionSchema.ID, entries, model, request }))
  expect(result).toBe(true)
})

test("compaction config defaults prune to true and max_context is undefined when not set", () => {
  // Decode-time defaults only apply through Schema.decode, not the class constructor.
  const info = Schema.decodeUnknownSync(ConfigCompaction.Info)({})
  expect(info.max_context).toBeUndefined()
  expect(info.prune).toBe(true)
})
