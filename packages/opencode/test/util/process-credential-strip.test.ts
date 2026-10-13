import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { credentialEnvKeys } from "@opencode-ai/core/util/credential-env"

// The opencode Process.spawn (src/util/process.ts) imports `launch` from
// "cross-spawn" as its OS-boundary spawn. Mock that boundary so this test can
// assert the env object the spawn actually RECEIVED -- the task hand-off
// contract -- without launching a real child. Process.spawn post-processes the
// child: it registers .once("exit"/"error"), may .kill(), and assigns .exited.
type FakeChild = {
  exitCode: number | null
  signalCode: number | null
  pid: number
  stdin: object
  stdout: object
  stderr: object
  once: (event: string, cb: (...args: unknown[]) => void) => void
  kill: (signal?: NodeJS.Signals | number) => void
  exited: Promise<number>
}

let capturedEnv: NodeJS.ProcessEnv | undefined

const makeFakeChild = (): FakeChild => ({
  exitCode: null,
  signalCode: null,
  pid: 4242,
  stdin: {},
  stdout: {},
  stderr: {},
  once: () => {},
  kill: () => {},
  exited: Promise.resolve(0),
})

// Capture the real cross-spawn default launch BEFORE registering the mock so
// we can restore it after this file's tests run. Bun's mock.module is
// process-global and re-registration for the same specifier overwrites; the
// bare `{ default: realLaunch }` re-registration in afterAll hands the real
// spawner back to every sibling test that spawns real children in the same
// `bun test` invocation. Without this restore, every later test that boots
// an opencode instance (LSP, shell, ripgrep, VCS, session.compaction, etc.)
// would receive the fake-child factory (only `.once()`), crash with
// `proc.on is not a function`, and reproduce the cross-file leak class
// already fixed in server-credential-strip.test.ts.
const realLaunch = (await import("cross-spawn")).default

void mock.module("cross-spawn", () => ({
  default: (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    capturedEnv = opts.env
    return makeFakeChild()
  },
}))

import { Process } from "@/util/process"

const setCredentialEnv = () => {
  process.env.OPENCODE_AUTH_CONTENT = "fake-secret-auth"
  process.env.HORDECODE_AUTH_CONTENT = "fake-secret-horde-auth"
  process.env.OPENCODE_CONFIG_CONTENT = "fake-secret-config"
  process.env.HORDECODE_CONFIG_CONTENT = "fake-secret-horde-config"
}

const clearCredentialEnv = () => {
  for (const key of credentialEnvKeys()) {
    delete process.env[key]
  }
}

describe("util.process credential strip (choke point)", () => {
  afterAll(() => {
    mock.module("cross-spawn", () => ({ default: realLaunch }))
  })

  afterEach(() => {
    clearCredentialEnv()
    capturedEnv = undefined
  })

  test("no-env spawn receives an env scrubbed of credential keys", async () => {
    setCredentialEnv()
    const child = Process.spawn([process.execPath, "-e", ""], {})
    expect(child).toBeDefined()
    expect(capturedEnv).toBeDefined()
    for (const key of credentialEnvKeys()) {
      expect(capturedEnv).not.toHaveProperty(key)
    }
    // Non-credential inherited env must survive the scrub.
    expect(capturedEnv?.PATH).toBeTypeOf("string")
  })

  test("spawn with explicit env keeps extras and still scrubs inherited credentials", async () => {
    setCredentialEnv()
    Process.spawn([process.execPath, "-e", ""], { env: { FOO: "bar" } })
    expect(capturedEnv?.FOO).toBe("bar")
    for (const key of credentialEnvKeys()) {
      expect(capturedEnv).not.toHaveProperty(key)
    }
  })

  test("env: null spawn receives an empty env", async () => {
    setCredentialEnv()
    Process.spawn([process.execPath, "-e", ""], { env: null })
    expect(capturedEnv).toEqual({})
  })
})
