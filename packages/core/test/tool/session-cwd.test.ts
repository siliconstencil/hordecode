import { describe, expect, test } from "bun:test"
import { SessionCwd } from "../../src/tool/session-cwd"
import type { SessionID } from "../../src/session/schema"

// Tool execution fibers do not carry the Instance AsyncLocalStorage context,
// so `get` must be usable with the caller's InstanceState.context directory
// as fallback (change_directory and view_image failed with "No context found
// for instance" before this existed).
describe("SessionCwd.get", () => {
  const id = "ses_cwd_test" as SessionID

  test("returns the fallback when nothing is set and no Instance context is active", () => {
    SessionCwd.clear(id)
    expect(SessionCwd.get(id, "/fallback")).toBe("/fallback")
  })

  test("a session cwd set by change_directory wins over the fallback", () => {
    SessionCwd.set(id, "/session/dir")
    expect(SessionCwd.get(id, "/fallback")).toBe("/session/dir")
    SessionCwd.clear(id)
    expect(SessionCwd.get(id, "/fallback")).toBe("/fallback")
  })

  test("without a fallback outside the Instance context it throws the context error", () => {
    SessionCwd.clear(id)
    expect(() => SessionCwd.get(id)).toThrow("No context found for instance")
  })
})
