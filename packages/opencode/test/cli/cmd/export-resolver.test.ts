// regression test: `hordecode export` must tolerate a partial session ID
// (a prefix of the full ses_<rest> string) by falling back to a bounded
// listGlobal scan when the exact get() lookup fails. Exact full IDs continue
// to resolve without a list scan; zero or ambiguous prefix matches surface
// the typed NotFoundError so the CLI can render "Session not found".
import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { NotFoundError } from "../../../src/storage/storage"
import { SessionID } from "../../../src/session/schema"
import { resolveSessionByPrefix } from "../../../src/cli/cmd/export"

// In-memory Session.Interface stub. Real `Session.Service` lives in
// packages/opencode/src/session/session.ts and would need a database +
// instance lifecycle, far more than a unit test for prefix resolution should
// pull in. The helper only ever touches `get` and `listGlobal`.
function makeStub(opts: {
  exact?: { id: string; title?: string }
  listed?: Array<{ id: string; title?: string }>
}) {
  const calls = { get: 0, listGlobal: 0 }
  const listed = (opts.listed ?? []).map((s) => ({
    id: SessionID.make(s.id),
    title: s.title ?? "",
  }))
  // The helper only ever touches `get` and `listGlobal`. Cast the stub to the
  // helper's expected Service shape so generic inference flows through and
  // `result.id` is typed as a real string in the assertions below.
  const svc = {
    get: (id: SessionID) => {
      calls.get += 1
      if (opts.exact && opts.exact.id === id) {
        return Effect.succeed({ id, title: opts.exact.title ?? "exact" })
      }
      return Effect.fail(new NotFoundError({ message: `not found: ${id}` }))
    },
    listGlobal: (input?: { limit?: number }) => {
      calls.listGlobal += 1
      return Effect.succeed(listed.slice(0, input?.limit ?? 200))
    },
  } as unknown as Parameters<typeof resolveSessionByPrefix>[0]
  return { calls, svc }
}

describe("resolveSessionByPrefix", () => {
  it("returns the full session info on an exact ID match without falling back to listGlobal", async () => {
    const stub = makeStub({ exact: { id: "ses_abc123" } })
    const result = await Effect.runPromise(resolveSessionByPrefix(stub.svc, SessionID.make("ses_abc123")))
    expect((result as { id: string }).id).toBe("ses_abc123")
    expect(stub.calls.get).toBe(1)
    expect(stub.calls.listGlobal).toBe(0)
  })

  it("falls back to a listGlobal prefix scan and returns the unique match", async () => {
    // Single match in the list: "ses_abc" prefix matches only "ses_abc123".
    const stub = makeStub({ listed: [{ id: "ses_abc123" }, { id: "ses_def456" }] })
    const result = await Effect.runPromise(resolveSessionByPrefix(stub.svc, SessionID.make("ses_abc")))
    expect((result as { id: string }).id).toBe("ses_abc123")
    expect(stub.calls.get).toBe(1)
    expect(stub.calls.listGlobal).toBe(1)
  })

  it("fails with NotFoundError when the prefix matches multiple sessions (ambiguous)", async () => {
    // 2 matches: ambiguous prefix; helper must surface NotFoundError instead of guessing.
    const stub = makeStub({ listed: [{ id: "ses_abc111" }, { id: "ses_abc222" }] })
    const exit = await Effect.runPromiseExit(resolveSessionByPrefix(stub.svc, SessionID.make("ses_abc")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as unknown as { _tag?: string; message?: string }
      expect(failure._tag).toBe("NotFoundError")
      expect(failure.message).toContain("ses_abc")
    }
  })

  it("fails with NotFoundError when the prefix matches nothing", async () => {
    const stub = makeStub({ listed: [{ id: "ses_xyz789" }] })
    const exit = await Effect.runPromiseExit(resolveSessionByPrefix(stub.svc, SessionID.make("ses_zzz")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as unknown as { _tag?: string; message?: string }
      expect(failure._tag).toBe("NotFoundError")
      expect(failure.message).toContain("ses_zzz")
    }
  })
})
