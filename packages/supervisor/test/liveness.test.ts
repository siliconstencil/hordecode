// Pure-derivation table for deriveLiveness. No I/O -- pins the rule + threshold
// exactly. Ported from the upstream reference implementation's
// test/liveness.test.ts (the pure-derivation block).
//
// The evidence is lastActivityTime (the last activity heartbeat for the
// supervisor's slice), NOT lastTurnTime/turnCount. Cases cover:
// - running + recent activity -> progressing
// - running + activity older than stallMs -> stalled
// - child mid-step with recent activity but ancient lastTurnTime -> progressing
//   (defense against step-grained false-positives)
// - pending (never had a turn) with recent activity -> progressing
// - running with NO lastActivityTime (pre-migration row, fallback to time.created)
// - terminal idle + lastOutcome=failure -> "failure"
// - terminal idle + lastOutcome=cancelled -> "cancelled"
// - terminal idle + lastOutcome=success -> "idle"
// - active past abandonMs -> "idle"

import { describe, expect, test } from "bun:test"
import {
  deriveLiveness,
  DEFAULT_LIVENESS_STALL_MS,
  DEFAULT_LIVENESS_ABANDON_MS,
} from "../src/schema"

describe("deriveLiveness (supervisor derivation rule)", () => {
  const now = 1_000_000

  test("running + recent activity (within stallMs) -> progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("running + activity older than stallMs -> stalled", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - (DEFAULT_LIVENESS_STALL_MS + 1),
          time: { created: now - 10 * 60_000, updated: now },
        },
        now,
      ),
    ).toBe("stalled")
  })

  // Defense against step-grained false-positives: a child inside a long tool
  // call has completed no step, so lastTurnTime/turnCount are frozen. Under the
  // old signal it would read stalled (or, past abandonMs, idle). Parts keep
  // landing so activity is recent -- it must read progressing. lastTurnTime
  // is deliberately ancient here to prove the derivation does not consult it.
  test("running with recent activity but ancient spawn -> progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - 2_000,
          time: { created: now - 25 * 60_000, updated: now - 2_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("pending (no turn yet) with recent activity -> progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "pending",
          lastOutcome: undefined,
          lastActivityTime: now - 500,
          time: { created: now - 500, updated: now - 500 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  // Pre-migration rows where lastActivityTime is undefined: fall back to
  // time.created (do not treat undefined as "now" via !== undefined guard).
  test("running + no lastActivityTime, within stallMs of time.created -> progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: undefined,
          time: { created: now - 1_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("running + no lastActivityTime, past stallMs of time.created -> stalled", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: undefined,
          time: { created: now - (DEFAULT_LIVENESS_STALL_MS + 1), updated: now },
        },
        now,
      ),
    ).toBe("stalled")
  })

  test("running + no lastActivityTime, past abandonMs of time.created -> idle", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: undefined,
          time: { created: now - (DEFAULT_LIVENESS_ABANDON_MS + 1), updated: now },
        },
        now,
      ),
    ).toBe("idle")
  })

  test("idle + lastOutcome=failure -> failure", () => {
    expect(
      deriveLiveness(
        {
          status: "idle",
          lastOutcome: "failure",
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("failure")
  })

  test("idle + lastOutcome=cancelled -> cancelled", () => {
    expect(
      deriveLiveness(
        {
          status: "idle",
          lastOutcome: "cancelled",
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("cancelled")
  })

  test("idle + lastOutcome=success -> idle", () => {
    expect(
      deriveLiveness(
        {
          status: "idle",
          lastOutcome: "success",
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("idle")
  })

  test("idle + no lastOutcome -> idle (terminal but unresolved)", () => {
    expect(
      deriveLiveness(
        {
          status: "idle",
          lastOutcome: undefined,
          lastActivityTime: now - 1_000,
          time: { created: now - 60_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("idle")
  })

  test("exact-threshold edge: activity exactly at stallMs -> progressing (inclusive bound)", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - DEFAULT_LIVENESS_STALL_MS,
          time: { created: now - 60_000, updated: now - DEFAULT_LIVENESS_STALL_MS },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("1ms past stallMs -> stalled", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - (DEFAULT_LIVENESS_STALL_MS + 1),
          time: { created: now - 60_000, updated: now - (DEFAULT_LIVENESS_STALL_MS + 1) },
        },
        now,
      ),
    ).toBe("stalled")
  })

  test("exact-threshold edge: activity exactly at abandonMs -> stalled (stalled <= now-since <= abandonMs)", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastActivityTime: now - DEFAULT_LIVENESS_ABANDON_MS,
          time: { created: now - 60_000, updated: now - DEFAULT_LIVENESS_ABANDON_MS },
        },
        now,
      ),
    ).toBe("stalled")
  })
})
