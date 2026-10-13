import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  HORDECODE_SERVER_PASSWORD: Flag.HORDECODE_SERVER_PASSWORD,
  HORDECODE_SERVER_USERNAME: Flag.HORDECODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.HORDECODE_SERVER_PASSWORD = original.HORDECODE_SERVER_PASSWORD
  Flag.HORDECODE_SERVER_USERNAME = original.HORDECODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.HORDECODE_SERVER_PASSWORD = undefined
    Flag.HORDECODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the hordecode username", () => {
    Flag.HORDECODE_SERVER_PASSWORD = "secret"
    Flag.HORDECODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("hordecode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.HORDECODE_SERVER_PASSWORD = "secret"
    Flag.HORDECODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.HORDECODE_SERVER_PASSWORD = "secret"
    Flag.HORDECODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  //  when the server has no password configured, a client that sends
  // --password is silently accepted because `ServerAuth.required(config)`
  // short-circuits the credential check. The boot-time warning in
  // authorization.ts makes this mismatch visible to the operator.
  test("required() returns false when no password is configured", () => {
    const config = { password: Option.none(), username: "hordecode" }

    expect(ServerAuth.required(config)).toBe(false)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("anything") }, config)).toBe(false)
  })

  // Timing-safe credential compare: length mismatch must
  // return false without leaking length or attempting to hash unequal
  // buffers (timingSafeEqual throws on length mismatch).
  test("authorized() rejects a wrong-length password without timing leak", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("shorter") }, config),
    ).toBe(false)
    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("a-much-longer-password") }, config),
    ).toBe(false)
  })

  test("authorized() rejects a same-length wrong password", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("secres") }, config),
    ).toBe(false)
  })

  test("authorized() rejects a wrong username even when password matches", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(
      ServerAuth.authorized({ username: "bob", password: Redacted.make("secret") }, config),
    ).toBe(false)
  })
})
