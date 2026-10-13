import { describe, expect, test } from "bun:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { SubagentProgressCheckerPlugin } from "@/plugin/subagent-progress-checker"

// The plugin client is an async boundary (plain `client.config.get()` with no
// Effect context); the gate is exercised with a stub client returning real
// config shapes. The journal path is derived from sessionID/taskId and never
// reached when the gate bails, so no filesystem fixture is needed.

type StubClient = {
  config: {
    get: () => Promise<{ data: { memory?: { disable_write?: boolean } } }>
  }
}

function makeClient(disableWrite: boolean): StubClient {
  return {
    config: {
      get: async () => ({ data: { memory: { disable_write: disableWrite } } }),
    },
  }
}

async function runPostStop(
  client: StubClient,
  input: Record<string, unknown>,
): Promise<{ continue?: boolean; reason?: string }> {
  const hooks: Hooks = await SubagentProgressCheckerPlugin({
    client,
  } as unknown as PluginInput)
  const output: { continue?: boolean; reason?: string } = {}
  const registration = hooks["supervisor.postStop"]
  if (!registration) {
    throw new Error("expected supervisor.postStop registration")
  }
  if (typeof registration === "function") {
    throw new Error("expected object registration with run()")
  }
  await registration.run(input as never, output as never)
  return output
}

describe("subagent-progress-checker write gate", () => {
  test("bails before the first nudge when memory.disable_write is true", async () => {
    const output = await runPostStop(makeClient(true), {
      task_id: "T1",
      sessionID: "ses_test",
      agentType: "explore",
      canWrite: true,
    })
    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  test("still nudges when memory writing is enabled", async () => {
    const output = await runPostStop(makeClient(false), {
      task_id: "T1",
      sessionID: "ses_test",
      agentType: "explore",
      canWrite: true,
    })
    expect(output.continue).toBe(true)
    expect(output.reason).toContain("Before terminating, write the task progress journal")
  })

  test("fails open on config read error (never silently disables the check)", async () => {
    const client = {
      config: {
        get: async () => {
          throw new Error("network down")
        },
      },
    }
    const output = await runPostStop(client, {
      task_id: "T1",
      sessionID: "ses_test",
      agentType: "explore",
      canWrite: true,
    })
    expect(output.continue).toBe(true)
    expect(output.reason).toContain("task progress journal")
  })
})
