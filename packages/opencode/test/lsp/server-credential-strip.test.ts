import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { credentialEnvKeys } from "@opencode-ai/core/util/credential-env"
import { Module } from "@opencode-ai/core/util/module"
import { Npm } from "@opencode-ai/core/npm"
import { Process } from "@/util/process"
import { Typescript } from "@/lsp/server"
import type { InstanceContext } from "@/project/instance-context"
import type { RuntimeFlags } from "@/effect/runtime-flags"

// server.ts builds the child env itself with `{ ...withoutCredentials(process.env) }`
// (a layer above the choke-point scrub in Process.spawn, covered by
// process-credential-strip.test.ts). This test captures the env at the point where
// launch.ts hands it to Process.spawn. Everything is intercepted with spyOn on
// member access (Process.spawn, Module.resolve, Npm.which) and restored after each
// test: no process-global mock.module, so this file can share a bun process with the
// rest of test/lsp.
let capturedEnv: NodeJS.ProcessEnv | undefined

const setCredentialEnv = () => {
  process.env.OPENCODE_AUTH_CONTENT = "fake-secret-auth"
  process.env.HORDECODE_AUTH_CONTENT = "fake-secret-horde-auth"
}

const clearCredentialEnv = () => {
  for (const key of credentialEnvKeys()) {
    delete process.env[key]
  }
}

const makeCtx = (directory: string): InstanceContext => {
  return { directory, worktree: "/", project: {} as never }
}

describe("builtin Typescript LSP server spawn credential strip", () => {
  const spies: Array<{ mockRestore: () => void }> = []

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
    clearCredentialEnv()
    capturedEnv = undefined
  })

  test("Typescript.spawn strips credential keys from the env it passes to the child", async () => {
    const dir = path.join(__dirname, ".server-strip-tmp")
    setCredentialEnv()

    spies.push(spyOn(Module, "resolve").mockImplementation(() => "/fake/tsserver.js"))
    spies.push(spyOn(Npm, "which").mockImplementation(async () => "/fake/tls"))
    spies.push(
      spyOn(Process, "spawn").mockImplementation(((_cmd: string[], opts?: Process.Options) => {
        capturedEnv = opts?.env ?? undefined
        return { stdin: {}, stdout: {}, stderr: {}, exited: Promise.resolve(0) } as unknown as Process.Child
      }) as typeof Process.spawn),
    )

    const handle = await Typescript.spawn(
      dir,
      makeCtx(dir),
      { disableLspDownload: false } as RuntimeFlags.Info,
    )

    expect(handle).toBeDefined()
    expect(capturedEnv).toBeDefined()
    for (const key of credentialEnvKeys()) {
      expect(capturedEnv).not.toHaveProperty(key)
    }
    // Non-credential inherited env must survive the scrub.
    expect(capturedEnv?.PATH).toBeTypeOf("string")
    // The resolved tsserver path is carried into the initialization block.
    expect(handle?.initialization?.tsserver?.path).toBe("/fake/tsserver.js")
  })
})
