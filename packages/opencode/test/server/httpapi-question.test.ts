// Real HTTP round-trip coverage for the question HttpApi group.  closes
// the zero-test-invocation gap for the 5 endpoints in
// packages/opencode/src/server/routes/instance/httpapi/groups/question.ts:
//   - GET  /question                   -> list pending question asks
//   - POST /question/:requestID/reply  -> answer a question
//   - POST /question/:requestID/reject -> reject a question
//   - GET  /question/never-ask         -> read never-ask state
//   - POST /question/never-ask         -> write never-ask state
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { SessionID } from "@opencode-ai/schema/session-id"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, afterEach } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { filesystem, path as pathNode } from "@opencode-ai/core/effect/app-node-platform"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Git } from "../../src/git"
import { Storage } from "../../src/storage/storage"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { requestInDirectory } from "./httpapi-layer"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    Question.node,
    Storage.node,
    EventV2Bridge.node,
    EventV2.node,
    Database.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
    Git.node,
    filesystem,
    pathNode,
    InstanceStore.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiServerLayer))

const QUESTION_LIST = "/question"
const QUESTION_REPLY = (id: string) => `/question/${id}/reply`
const QUESTION_REJECT = (id: string) => `/question/${id}/reject`
const QUESTION_NEVER_ASK = "/question/never-ask"

const baseQuestion = (sessionID: SessionID) => ({
  sessionID,
  questions: [
    {
      question: "Which framework?",
      header: "framework",
      options: [
        { label: "React", description: "Meta's UI library" },
        { label: "Vue", description: "Progressive framework" },
      ],
    },
  ] as ReadonlyArray<Question.Info>,
})

afterEach(async () => {
  await resetDatabase()
})

describe("question HttpApi", () => {
  it.live("GET /question returns an empty array when no pending questions exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(QUESTION_LIST, dir)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([])
    }),
  )

  it.live("GET /question returns pending questions created via the ask service", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = `ses_q_list_${Date.now()}` as SessionID

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const question = yield* Question.Service
          // Fork ask to a fiber scoped to the test scope (so it survives provideInstance's
          // release but is interrupted on test exit). This mirrors the real usage where
          // an agent call awaits the question asynchronously.
          yield* question.ask(baseQuestion(sessionID)).pipe(Effect.forkScoped)
          // Wait for the ask to publish into the pending list, not wall-clock time.
          // Effect.sleep races the scheduler under load.
          yield* pollWithTimeout(
            question.list().pipe(Effect.map((arr) => (arr.length > 0 ? true : undefined))),
            "pending question never appeared in Question.list()",
          )
        }),
      )

      const response = yield* requestInDirectory(QUESTION_LIST, dir)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Array<{ sessionID: string; questions: ReadonlyArray<{ question: string }> }>
      expect(body.length).toBe(1)
      expect(body[0]?.sessionID).toBe(sessionID)
      expect(body[0]?.questions[0]?.question).toBe("Which framework?")
    }),
  )

  it.live("POST /question/:id/reply answers a pending question and returns true", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = `ses_q_reply_${Date.now()}` as SessionID

      const id: QuestionID = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const question = yield* Question.Service
          yield* question.ask(baseQuestion(sessionID)).pipe(Effect.forkScoped({ startImmediately: true }))
          // Wait for the ask to publish into the pending list, not wall-clock time.
          // pollWithTimeout resolves on the first non-undefined result, so the
          // predicate returns the list when it has at least one entry, undefined
          // otherwise -- an empty array is "not yet", not "done".
          const pending = yield* pollWithTimeout(
            question.list().pipe(Effect.map((arr) => (arr.length > 0 ? arr : undefined))),
            "pending question never appeared in Question.list()",
          )
          if (pending.length === 0) return yield* Effect.fail(new Error("no pending question"))
          return pending[0]?.id as QuestionID
        }),
      )

      const path = QUESTION_REPLY(id)
      const response = yield* requestInDirectory(path, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [["React"]] }),
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
    }),
  )

  it.live("POST /question/:id/reject rejects a pending question and returns true", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = `ses_q_reject_${Date.now()}` as SessionID

      const id: QuestionID = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const question = yield* Question.Service
          yield* question.ask(baseQuestion(sessionID)).pipe(Effect.forkScoped({ startImmediately: true }))
          // Wait for the ask to publish into the pending list, not wall-clock time.
          // pollWithTimeout resolves on the first non-undefined result, so the
          // predicate returns the list when it has at least one entry, undefined
          // otherwise -- an empty array is "not yet", not "done".
          const pending = yield* pollWithTimeout(
            question.list().pipe(Effect.map((arr) => (arr.length > 0 ? arr : undefined))),
            "pending question never appeared in Question.list()",
          )
          if (pending.length === 0) return yield* Effect.fail(new Error("no pending question"))
          return pending[0]?.id as QuestionID
        }),
      )

      const path = QUESTION_REJECT(id)
      const response = yield* requestInDirectory(path, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
    }),
  )

  it.live("GET /question/never-ask returns the current never-ask state", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(QUESTION_NEVER_ASK, dir)
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(false)
    }),
  )

  it.live("POST /question/never-ask updates the never-ask state and returns true", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const write = yield* requestInDirectory(QUESTION_NEVER_ASK, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
      expect(write.status).toBe(200)
      expect(yield* write.json).toBe(true)

      const read = yield* requestInDirectory(QUESTION_NEVER_ASK, dir)
      expect(yield* read.json).toBe(true)
    }),
  )
})
