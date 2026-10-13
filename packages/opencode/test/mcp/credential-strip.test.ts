import { afterAll, afterEach, describe, expect, mock } from "bun:test"
import { credentialEnvKeys } from "@opencode-ai/core/util/credential-env"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// connectLocal (src/mcp/index.ts) builds the stdio transport env as
// `{ ...withoutCredentials(process.env), ...(BUN_BE_BUN), ...mcp.environment }`
// and hands it to `new StdioClientTransport({ ..., env })`. Stub that
// constructor so this test can assert the env object the transport actually
// RECEIVED -- the task hand-off contract -- while still driving the real
// connectLocal code path through the MCP service layer.
let capturedEnv: NodeJS.ProcessEnv | undefined

// Capture the real StdioClientTransport class BEFORE registering the mock so
// we can restore it via afterAll. Same leak class as server-credential-strip
// and process-credential-strip: without restore, every later test that boots
// an MCP client via the SDK would receive the fake transport, which never
// finishes its `start()` properly, hanging tests on the 30s connect timeout.
const realStdioClientTransport = (await import(
  "@modelcontextprotocol/sdk/client/stdio.js"
)).StdioClientTransport

class FakeStdioTransport {
  sessionId = undefined
  onmessage: ((message: unknown) => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onclose: (() => void) | undefined

  constructor(opts: { env?: NodeJS.ProcessEnv }) {
    capturedEnv = opts.env
  }

  start() {
    // Fail fast so the SDK Client.connect rejects immediately instead of
    // hanging on a 30s connect timeout. Env is captured in the constructor,
    // before start() is ever called.
    return Promise.reject(new Error("fake transport: no real server"))
  }

  close() {
    return Promise.resolve()
  }

  send() {
    return Promise.reject(new Error("fake transport: no real server"))
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: FakeStdioTransport,
}))

const it = testEffect(LayerNode.compile(MCP.node))

const setCredentialEnv = () => {
  // Only the *_AUTH_CONTENT vars: the engine's config loader actively reads
  // *_CONFIG_CONTENT as a JSON config override (config.ts), so poisoning it
  // here would break the MCP layer under test. The strip assertion checks all
  // of credentialEnvKeys() regardless of which are actually present.
  process.env.OPENCODE_AUTH_CONTENT = "fake-secret-auth"
  process.env.HORDECODE_AUTH_CONTENT = "fake-secret-horde-auth"
}

const clearCredentialEnv = () => {
  for (const key of credentialEnvKeys()) {
    delete process.env[key]
  }
}

describe("mcp connectLocal credential strip", () => {
  afterAll(() => {
    mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: realStdioClientTransport,
    }))
  })

  afterEach(() => {
    clearCredentialEnv()
    capturedEnv = undefined
  })

  it.instance(
    "stdio transport env strips credential keys and keeps mcp.environment",
    () =>
      MCP.Service.use((mcp) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          expect(test.directory).toBeDefined() // instance dir bound before connect
          setCredentialEnv()
          const result = yield* mcp.add("cred-strip", {
            type: "local",
            command: ["node", "-e", ""],
            environment: { CUSTOM_ENV: "from-config" },
          })
          // Connection fails against the fake transport, but the constructor
          // already captured the env; add() returns the failed status.
          expect(result.status).toBeDefined()
          expect(capturedEnv).toBeDefined()
          expect(capturedEnv?.CUSTOM_ENV).toBe("from-config")
          for (const key of credentialEnvKeys()) {
            expect(capturedEnv).not.toHaveProperty(key)
          }
        }),
      ),
  )
})
