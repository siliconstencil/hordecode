import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Bus } from "@opencode-ai/bus"
import { SupervisorRegistryService } from "@opencode-ai/supervisor"
import { Inbox } from "@opencode-ai/inbox"
import { InboxArrived } from "@opencode-ai/supervisor/events"
import { Database } from "@opencode-ai/core/database/database"
import { Database as StorageDb } from "@opencode-ai/core/storage"
import { Session } from "@opencode-ai/core/session"
import { sessionPromptRef } from "@opencode-ai/inbox/inbox-ref"
import fs from "fs"

const LOG = "/tmp/hordecode/stress-supervisor-inbox.log"
function log(line: string) {
  const ts = new Date().toISOString()
  const msg = `[${ts}] ${line}`
  fs.appendFileSync(LOG, msg + "\n")
  console.log(msg)
}

// Mock Session that satisfies Inbox.drain's dependency
function mockSessionLayer() {
  const svc = Session.Service.of({
    // only messages + updateMessage + updatePart needed by drain
    messages: (_input: any) =>
      Effect.succeed([
        {
          info: {
            role: "user",
            agent: "test-agent",
            model: { providerID: "test", modelID: "test" },
          },
        },
      ] as any),
    updateMessage: (_input: any) => Effect.void,
    updatePart: (_input: any) => Effect.void,
  } as any)
  return Layer.succeed(Session.Service, svc)
}

describe("stress supervisor/inbox sequential READY harness", () => {
  test("light 2-3 supervisor sequential: expect running 100% idle wake 100% with full logging", async () => {
    fs.writeFileSync(LOG, "")
    log("=== stress START ===")

    let wakeCount = 0
    sessionPromptRef.current = {
      loop: (input: { sessionID: string; agentID: string }) => {
        wakeCount++
        log(`wake#${wakeCount} session=${input.sessionID} supervisor=${input.agentID}`)
        return Effect.void
      },
    } as any

    const layer = Layer.mergeAll(Bus.defaultLayer).pipe(
      Layer.provideMerge(mockSessionLayer()),
      Layer.provideMerge(SupervisorRegistryService.defaultLayer),
      Layer.provideMerge(Inbox.defaultLayer),
      // Database.Service layer init runs DatabaseMigration.apply, which creates
      // the `inbox` table on the shared test DB (same file the static
      // `Database.use()`/`Client()` opens via HORDECODE_DB/OPENCODE_DB).
      Layer.provideMerge(
        Database.layerFromPath(
          process.env.HORDECODE_DB ?? process.env.OPENCODE_DB ?? ":memory:",
        ) as Layer.Layer<Database.Service, never, never>,
      ),
    ) as Layer.Layer<any, never, never>

    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const reg = yield* SupervisorRegistryService.Service
        const inbox = yield* Inbox.Service

        let arrivedCount = 0
        yield* (bus as any).subscribeCallback(InboxArrived, (ev: any) => {
          arrivedCount++
          log(`bus arrived#${arrivedCount} recv=${ev.receiverSupervisorID} inbox=${ev.inboxID} sender=${(ev as any).senderSupervisorID ?? "?"}`)
        })

        const sessionID = `ses_stress_${Date.now()}` as any
        // Insert session row via DB so SupervisorRegistryService foreign key not enforced but Inbox needs reg.get to find supervisor
        yield* Effect.sync(() =>
          StorageDb.use((db) => {
            try {
              const { SessionTable } = require("@opencode-ai/core/session/sql")
              const { ProjectTable } = require("@opencode-ai/core/project/sql")
              db.insert(ProjectTable)
                .values({ id: "test", worktree: "/tmp", sandboxes: [] })
                .onConflictDoNothing()
                .run()
              db.insert(SessionTable)
                .values({
                  id: sessionID,
                  slug: sessionID,
                  parent_id: null,
                  project_id: "test",
                  directory: "/tmp",
                  title: "stress",
                  version: "test",
                  time_created: Date.now(),
                  time_updated: Date.now(),
                })
                .run()
              log(`session inserted ${sessionID}`)
            } catch (e) {
              log(`session insert err: ${String(e).slice(0, 300)}`)
            }
          }),
        )

        const supervisors = ["supervisor-1", "supervisor-2", "supervisor-3"]
        log(`registering ${supervisors.length} supervisors sequentially (READY barrier)`)

        for (const aid of supervisors) {
          const a = yield* reg.register({
            sessionID,
            supervisorID: aid,
            mode: "background" as any,
            agent: "test-agent",
            description: `stress ${aid}`,
            contextMode: "isolated" as any,
            background: true,
            lifecycle: "persistent" as any,
          })
          log(`registered ${aid} status=${a.status}`)
          yield* reg.updateStatus(sessionID, aid, { status: "running" })
          log(`READY ${aid} -> running`)
          yield* reg.updateTurn(sessionID, aid)
          yield* reg.updateStatus(sessionID, aid, { status: "idle", lastOutcome: "success" })
          log(`READY ${aid} -> idle`)
        }

        const listed = yield* reg.listBySession(sessionID)
        const idleReady = listed.filter((a) => a.status === "idle").length
        log(`barrier: ${idleReady}/${supervisors.length} idle READY`)
        expect(idleReady).toBe(supervisors.length)

        const totalSends = 9
        let runningOk = 0
        let idleWakeOk = 0

        for (let i = 0; i < totalSends; i++) {
          const sender = supervisors[i % supervisors.length]
          const receiver = supervisors[(i + 1) % supervisors.length]
          log(`--- send ${i + 1}/${totalSends}: ${sender} -> ${receiver} ---`)

          yield* reg.updateStatus(sessionID, receiver, { status: "running" })
          const before = yield* reg.get(sessionID, receiver)
          if (before?.status === "running") {
            runningOk++
            log(`running OK ${receiver} (${runningOk}/${totalSends})`)
          } else {
            log(`FAIL running ${receiver} status=${before?.status}`)
          }

          const res = yield* inbox.send({
            receiverSessionID: sessionID,
            receiverSupervisorID: receiver,
            senderSessionID: sessionID,
            senderSupervisorID: sender,
            content: `msg ${i} from ${sender} to ${receiver}`,
          })
          log(`send OK inboxID=${res.inboxID}`)

          yield* Effect.sleep(20)

          // drain inbox (uses mocked Session)
          const drained = yield* inbox.drain(sessionID, receiver)
          log(`drain ${receiver}: ${drained} rows`)

          yield* reg.updateStatus(sessionID, receiver, { status: "idle", lastOutcome: "success" })
          yield* reg.updateTurn(sessionID, receiver)
          const after = yield* reg.get(sessionID, receiver)
          if (after?.status === "idle") {
            idleWakeOk++
            log(`idle wake OK ${receiver} (${idleWakeOk}/${totalSends})`)
          } else {
            log(`FAIL idle ${receiver} status=${after?.status}`)
          }
        }

        // give bus time to flush
        yield* Effect.sleep(100)

        const runningPct = ((runningOk / totalSends) * 100).toFixed(1)
        const wakePct = ((idleWakeOk / totalSends) * 100).toFixed(1)
        const busPct = ((arrivedCount / totalSends) * 100).toFixed(1)
        const promptPct = ((wakeCount / totalSends) * 100).toFixed(1)

        log(`=== RESULTS ===`)
        log(`running: ${runningOk}/${totalSends} = ${runningPct}% expect 100%`)
        log(`idle wake: ${idleWakeOk}/${totalSends} = ${wakePct}% expect 100%`)
        log(`bus arrived: ${arrivedCount}/${totalSends} = ${busPct}%`)
        log(`prompt wake: ${wakeCount}/${totalSends} = ${promptPct}%`)
        log(`log file: ${LOG}`)

        expect(runningOk).toBe(totalSends)
        expect(idleWakeOk).toBe(totalSends)
        expect(arrivedCount).toBe(totalSends)
        expect(wakeCount).toBe(totalSends)

        if (runningPct === "100.0" && wakePct === "100.0") log("PASS light READY-harness")
        else log("FAIL metrics")

        const finalActors = yield* reg.listBySession(sessionID)
        for (const a of finalActors) log(`final ${a.supervisorID} status=${a.status} turns=${a.turnCount} outcome=${a.lastOutcome}`)
        log("=== stress END ===")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  }, 30_000)
})
