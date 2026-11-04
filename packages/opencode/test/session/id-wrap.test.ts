import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { CompactionGuard } from "@/session/compaction-guard"
import { Identifier } from "@/id/id"
import { MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

// Ascending ids pack Date.now() * 4096 + counter into 6 bytes, so the time field wraps every 2^36 ms.
// The 26th wrap was 2026-08-14T11:19:55Z. A session that spans it holds ids whose string order
// disagrees with creation order.
const WRAP = 26 * 2 ** 36
const BEFORE = WRAP - 60_000
const AFTER = WRAP + 60_000

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const user = (id: string, sessionID: string, created: number) =>
  ({
    id: MessageID.make(id),
    sessionID,
    role: "user",
    time: { created },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
  }) as SessionV1.User

const assistant = (id: string, sessionID: string, created: number) =>
  ({
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    parentID: "msg_parent",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    time: { created },
    finish: "stop",
  }) as unknown as SessionV1.Assistant

describe("identifier order across the 2026-08-14 time-field wrap", () => {
  const msg = (ts: number) => Identifier.create("msg", "ascending", ts)

  it.instance("a message created after the wrap has the larger id", () =>
    Effect.sync(() => {
      expect(msg(BEFORE) < msg(AFTER)).toBe(true)
    }),
  )

  it.instance("timestamp() still recovers the creation time on both sides (control)", () =>
    Effect.sync(() => {
      expect(Identifier.timestamp(msg(BEFORE))).toBe(BEFORE)
      expect(Identifier.timestamp(msg(AFTER))).toBe(AFTER)
    }),
  )

  it.instance("Session.lastMainMessageID returns the newest message of a session spanning the wrap", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const older = msg(BEFORE)
      const newer = msg(AFTER)
      yield* session.updateMessage(user(older, created.id, BEFORE))
      yield* session.updateMessage(user(newer, created.id, AFTER))

      expect(yield* session.lastMainMessageID(created.id)).toBe(newer)
    }),
  )

  it.instance("Session.messages lists a session spanning the wrap in creation order (control)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      yield* session.updateMessage(user(msg(AFTER), created.id, AFTER))
      yield* session.updateMessage(user(msg(BEFORE), created.id, BEFORE))

      expect((yield* session.messages({ sessionID: created.id })).map((m) => m.info.time.created)).toEqual([
        BEFORE,
        AFTER,
      ])
    }),
  )

  it.instance("CompactionGuard counts a step finished after the wrap as progress", () =>
    Effect.gen(function* () {
      const state = CompactionGuard.make()
      const sid = "ses_wrap"
      // First compaction, triggered by a message created before the wrap.
      expect(CompactionGuard.advance(state, [], msg(BEFORE))).toBe(1)
      // The model then finished a real step, created after the wrap (smaller id string).
      const msgs = [{ info: assistant(msg(AFTER), sid, AFTER), parts: [] }] as unknown as SessionV1.WithParts[]
      // Progress was made, so the streak restarts at 1 instead of counting toward the loop limit.
      expect(CompactionGuard.advance(state, msgs, msg(AFTER + 1000))).toBe(1)
    }),
  )
})
