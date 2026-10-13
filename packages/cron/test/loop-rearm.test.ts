import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Scheduler, layer as schedLayer } from "../src/scheduler"
import { getSessionCronTasks, removeSessionCronTasks, clearSessionCronTasks } from "../src/cron-task"
import * as LoopState from "../src/loop-state"
import { unlink } from "fs/promises"
import { getSessionCronFilePath } from "../src/cron-task"
import { getLoopStateFilePath } from "../src/loop-state"

describe("loop re-arm", () => {
  beforeEach(async () => {
    LoopState.clearAllLoopStates()
    clearSessionCronTasks()
    // Best-effort delete persisted session + loop state files that the bridge now writes.
    // Without this, file-backed state leaks across tests that previously relied only on in-memory clear.
    await unlink(getSessionCronFilePath()).catch(() => {})
    await unlink(getLoopStateFilePath()).catch(() => {})
    // Also clear any cwd-relative .hordecode under packages/cron (when dir is undefined)
    await unlink(getSessionCronFilePath(process.cwd())).catch(() => {})
    await unlink(getLoopStateFilePath(process.cwd())).catch(() => {})
  })

  it("re-arms same id after one fire", async () => {
    const fires: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "test-sess-1",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
      })
      const res = yield* sched.armLoop({
        prompt: "loop probe A",
        delay_seconds: 60,
        reason_length: 0,
        session_id: "test-sess-1",
      })
      expect(res).not.toBeNull()
      const before = getSessionCronTasks()
      expect(before.length).toBe(1)
      const idBefore = before[0]!.id
      expect(res!.id).toBe(idBefore)
      const scheduledFor = res!.scheduledFor

      // Advance past due
      const origNow = Date.now
      const fakeNow = scheduledFor + 2000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }

      expect(fires.length).toBe(1)
      expect(fires[0]).toBe(idBefore)

      const after = getSessionCronTasks()
      expect(after.length).toBe(1)
      expect(after[0]!.id).toBe(idBefore)
      expect(LoopState.getLoopState("loop probe A")).not.toBeNull()
      expect(LoopState.getLoopState("loop probe A")!.clampedDelaySeconds).toBe(60)
      // nextFireAt should be > scheduledFor
      const stateAfter = LoopState.getLoopState("loop probe A")!
      expect(stateAfter.lastScheduledFor).toBeGreaterThan(scheduledFor)
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
  })

  it("fires twice consecutively with same id", async () => {
    const fires: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "test-sess-2",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
      })
      const res = yield* sched.armLoop({
        prompt: "loop probe B",
        delay_seconds: 60,
        reason_length: 0,
        session_id: "test-sess-2",
      })
      const idBefore = getSessionCronTasks().find((t) => t.prompt === "loop probe B")!.id
      let scheduledFor = res!.scheduledFor

      for (let round = 0; round < 2; round++) {
        const origNow = Date.now
        const fakeNow = scheduledFor + 2000
        // @ts-ignore
        Date.now = () => fakeNow
        try {
          yield* sched.tickOnce()
        } finally {
          Date.now = origNow
        }
        expect(fires.length).toBe(round + 1)
        const after = getSessionCronTasks().find((t) => t.prompt === "loop probe B")
        expect(after).toBeDefined()
        expect(after!.id).toBe(idBefore)
        scheduledFor = LoopState.getLoopState("loop probe B")!.lastScheduledFor
      }
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
  })

  it("one-shot cron still deleted after fire", async () => {
    const fires: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "test-sess-3",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: () => {},
      })
      const t = yield* sched.add({
        session_id: "test-sess-3",
        cron: "* * * * *",
        prompt: "one-shot probe",
        recurring: false,
        durable: false,
      })
      const origNow = Date.now
      const fakeNow = origNow() + 120_000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      if (fires.length === 0) {
        const origNow2 = Date.now
        const fakeNow2 = origNow2() + 300_000
        // @ts-ignore
        Date.now = () => fakeNow2
        try {
          yield* sched.tickOnce()
        } finally {
          Date.now = origNow2
        }
      }
      expect(fires).toContain(t.id)
      expect(getSessionCronTasks().find((x) => x.id === t.id)).toBeUndefined()
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
  })

  it("aged_out loop does not re-arm", async () => {
    const fires: string[] = []
    const loopEnded: string[] = []
    const program = Effect.gen(function* () {
      const sched = yield* Scheduler
      yield* sched.start({
        workspaceRoot: "/tmp",
        sessionID: "test-sess-4",
        isLoading: () => false,
        isKilled: () => false,
        onFire: (task) => fires.push(task.id),
        onLoopEnded: (e) => loopEnded.push(e.reason),
      })
      const res = yield* sched.armLoop({
        prompt: "loop probe aged",
        delay_seconds: 60,
        reason_length: 0,
        session_id: "test-sess-4",
      })
      expect(res).not.toBeNull()
      const idBefore = getSessionCronTasks().find((t) => t.prompt === "loop probe aged")!.id
      const scheduledFor = res!.scheduledFor
      // Age the loop beyond 7d by mutating LoopState startedAt
      const cur = LoopState.getLoopState("loop probe aged")!
      LoopState.setLoopState({ ...cur, startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
      // Persist mutated state so the bridge's tick sync (which reloads from file) sees the aged value.
      yield* LoopState.persistLoopState().pipe(Effect.orElseSucceed(() => undefined))
      const origNow = Date.now
      const fakeNow = scheduledFor + 2000
      // @ts-ignore
      Date.now = () => fakeNow
      try {
        yield* sched.tickOnce()
      } finally {
        Date.now = origNow
      }
      expect(fires.length).toBe(1)
      expect(fires[0]).toBe(idBefore)
      expect(getSessionCronTasks().find((t) => t.id === idBefore)).toBeUndefined()
      expect(LoopState.getLoopState("loop probe aged")).toBeNull()
      expect(loopEnded).toContain("aged_out")
      const sched2 = yield* Scheduler
      yield* sched2.stop()
    })
    await Effect.runPromise(Effect.provide(program, schedLayer))
  })
})
