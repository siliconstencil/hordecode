import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { InstanceRef } from "@opencode-ai/core/effect/instance-ref"
import { SessionID } from "@opencode-ai/core/session/schema"
import { TaskGate, MAX_TASK_GATE_MAIN_REACT, MAX_TASK_GATE_SUBAGENT_REACT } from "../src/gate"
import { TaskGateState } from "../src/gate-state"
import { TaskRegistry } from "../src/registry"
import type { Task } from "../src/schema"

const sid = SessionID.make("ses_gate_test")

const task = (id: string, status: Task["status"], summary = `work ${id}`): Task => ({
  id,
  session_id: sid,
  status,
  summary,
  created_at: 1,
  last_event_at: 1,
})

// The gate only calls list(); a registry that serves a fixed board keeps the test on the real decide().
const registry = (tasks: Task[] | "fail") =>
  Layer.succeed(
    TaskRegistry.Service,
    TaskRegistry.Service.of({
      list: () => (tasks === "fail" ? Effect.die("db down") : Effect.succeed(tasks)),
    } as unknown as TaskRegistry.Interface),
  )

const decide = (tasks: Task[] | "fail", input: Partial<Parameters<typeof TaskGate.decide>[0]> = {}) =>
  Effect.runPromise(
    TaskGate.decide({ session_id: sid, reactCount: 0, maxReact: MAX_TASK_GATE_MAIN_REACT, mode: "main", ...input }).pipe(
      Effect.provide(registry(tasks)),
    ),
  )

describe("TaskGate.decide", () => {
  test("caps are 3 for the main session and 2 for subagents", () => {
    expect(MAX_TASK_GATE_MAIN_REACT).toBe(3)
    expect(MAX_TASK_GATE_SUBAGENT_REACT).toBe(2)
  })

  test("an empty board lets the turn stop", async () => {
    expect(await decide([])).toEqual({ needReentry: false, capExceeded: false, incompleteTasks: [] })
  })

  test("open and in-progress tasks ask for a re-entry that names each task", async () => {
    const result = await decide([task("T1", "open"), task("T2", "in_progress"), task("T3", "done")])
    expect(result.needReentry).toBe(true)
    if (!result.needReentry || result.capExceeded) throw new Error("expected a re-entry")
    expect(result.incompleteTasks).toEqual(["T1", "T2"])
    expect(result.reentryText).toContain("- T1 (open): work T1")
    expect(result.reentryText).toContain("- T2 (in_progress): work T2")
    expect(result.reentryText).not.toContain("T3")
    expect(result.reentryText).toContain("tasks in this session are still unfinished")
    expect(result.reentryText).toContain("Then continue or respond.")
  })

  test("the subagent wording says the tasks are owned and asks for the status header", async () => {
    const result = await decide([task("T1", "open")], { mode: "subagent", maxReact: MAX_TASK_GATE_SUBAGENT_REACT })
    if (!result.needReentry || result.capExceeded) throw new Error("expected a re-entry")
    expect(result.reentryText).toContain("tasks you own are still unfinished")
    expect(result.reentryText).toContain("**Status**/**Summary**")
  })

  test("blocked tasks never trap the agent", async () => {
    expect(await decide([task("T1", "blocked")])).toEqual({ needReentry: false, capExceeded: false, incompleteTasks: [] })
  })

  test("at the cap the stop is allowed and the open tasks are reported", async () => {
    expect(await decide([task("T1", "open")], { reactCount: MAX_TASK_GATE_MAIN_REACT })).toEqual({
      needReentry: false,
      capExceeded: true,
      incompleteTasks: ["T1"],
    })
  })

  test("one nudge below the cap still re-enters", async () => {
    const result = await decide([task("T1", "open")], { reactCount: MAX_TASK_GATE_MAIN_REACT - 1 })
    expect(result.needReentry).toBe(true)
  })

  test("a registry failure fails open instead of trapping the agent", async () => {
    const failing = Layer.succeed(
      TaskRegistry.Service,
      TaskRegistry.Service.of({ list: () => Effect.fail(new Error("db down")) } as unknown as TaskRegistry.Interface),
    )
    const result = await Effect.runPromise(
      TaskGate.decide({ session_id: sid, reactCount: 0, maxReact: 3, mode: "main" }).pipe(Effect.provide(failing)),
    )
    expect(result).toEqual({ needReentry: false, capExceeded: false, incompleteTasks: [] })
  })
})

describe("TaskGateState", () => {
  const instance = { directory: "/tmp/gate-state", worktree: "/tmp/gate-state", project: { id: "p", worktree: "/tmp/gate-state", sandboxes: [] } } as never
  const run = <A>(effect: Effect.Effect<A, unknown, TaskGateState.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TaskGateState.defaultLayer), Effect.scoped, Effect.provideService(InstanceRef, instance)))

  test("counts bumps per session and clears them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const state = yield* TaskGateState.Service
        const other = SessionID.make("ses_gate_other")
        const start = yield* state.get(sid)
        const first = yield* state.bump(sid)
        const second = yield* state.bump(sid)
        const otherCount = yield* state.get(other)
        yield* state.clear(sid)
        return { start, first, second, otherCount, after: yield* state.get(sid) }
      }),
    )
    expect(result).toEqual({ start: 0, first: 1, second: 2, otherCount: 0, after: 0 })
  })
})
