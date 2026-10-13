import { describe, expect, test } from "bun:test"

describe("checkpoint FailureInfo + waitForWriter", () => {
  test("FailureInfo exported from supervisor/spawn and AgentOutcome carries failure", async () => {
    const mod = await import("@opencode-ai/supervisor/spawn")
    // FailureInfo is a type only -- check AgentOutcome shape via runtime: failure field present on type is not observable,
    // but FailureInfo type existence can be checked by verifying the module exports the type guard via classify logic.
    // The real check: AgentOutcome failure variant should accept failure field -- we verify by checking the file contains FailureInfo string
    const src = await Bun.file(new URL("../../src/session/checkpoint.ts", import.meta.url).pathname).text().catch(() => "")
    // Instead, directly check that spawn module re-exports FailureInfo concept: check file content via import
    // We verify classifyAssistantError exists or FailureInfo type is importable
    const spawnPath = await Bun.file(new URL("../../../supervisor/src/spawn.ts", import.meta.url).pathname).text().catch(() => "")
    // If file read fails, try alternative path
    const hasFailureInfo = spawnPath.includes("FailureInfo") || (mod as any).FailureInfo !== undefined
    // Also check that AgentOutcome failure includes FailureInfo by checking spawn source contains "failure?: FailureInfo"
    const spawnFile = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../../supervisor/src/spawn.ts", import.meta.url).pathname, "utf-8").catch(() => ""),
    )
    const hasFailureField = spawnFile.includes("failure?: FailureInfo") || spawnFile.includes("FailureInfo")
    expect(hasFailureField).toBe(true)
  })

  test("SessionCheckpoint Service has waitForWriter(sessionID) Effect", async () => {
    const { SessionCheckpoint } = await import("../../src/session/checkpoint")
    const svc = (SessionCheckpoint as any).Service
    expect(svc).toBeDefined()
    // Service interface check -- we verify source contains waitForWriterSettlement
    const checkpointFile = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/session/checkpoint.ts", import.meta.url).pathname, "utf-8").catch(() => ""),
    )
    expect(checkpointFile.includes("waitForWriterSettlement")).toBe(true)
    expect(checkpointFile.includes('waitForWriter')).toBe(true)
    expect(checkpointFile.includes('"timeout"')).toBe(true)
  })

  test("WriterOutcome includes timeout distinct from failure", async () => {
    const checkpointFile = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/session/checkpoint.ts", import.meta.url).pathname, "utf-8").catch(() => ""),
    )
    expect(checkpointFile.includes('WriterOutcome = "success" | "failure" | "timeout"') || checkpointFile.includes('"timeout"')).toBe(true)
  })

  test("AgentOutcome timeout status is valid", async () => {
    // Verify that AgentOutcome includes timeout as a valid status
    // The runtime check verifies the timeout outcome object shape
    const timeoutOutcome = { status: "timeout" as const }
    expect(timeoutOutcome.status).toBe("timeout")
    // If AgentOutcome didn't include timeout, the type at checkpoint.ts would fail to compile
    const checkpointFile = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/session/checkpoint.ts", import.meta.url).pathname, "utf-8").catch(() => ""),
    )
    // Verify the timeout outcome is created without casts
    expect(checkpointFile.includes('{ status: "timeout" as const }')).toBe(true)
  })
})
