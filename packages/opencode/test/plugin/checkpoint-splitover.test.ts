import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import type { PluginInput, SupervisorStopBaseInput } from "@opencode-ai/plugin"
import type { ProjectID } from "@opencode-ai/project/schema"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { CheckpointSplitoverPlugin } from "../../src/plugin/checkpoint-splitover"
import { checkpointPath, memoryPath, metaDir } from "@opencode-ai/core/session/checkpoint-paths"
import * as CheckpointContext from "@opencode-ai/core/session/checkpoint-context"

function tmpSessionID(): SessionID {
  return (`s_${Math.random().toString(36).slice(2, 10)}`) as SessionID
}
function tmpProjectID(): ProjectID {
  return (`proj_${Math.random().toString(36).slice(2, 10)}`) as ProjectID
}

async function setupSession(sessionID: SessionID, projectID: ProjectID): Promise<void> {
  await fs.mkdir(metaDir(sessionID), { recursive: true })
  await fs.mkdir(path.dirname(memoryPath(projectID)), { recursive: true })
}

// v5 clean checkpoint skeleton -- passes every fork validator (Topic: + the 3
// snapshot sections + the 2 learning sections) and is well under budget, so
// runValidatorsForCkpt returns zero violations.
const CLEAN_CHECKPOINT = `Topic: clean test checkpoint

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)

### Discovered
(none)

### Dead ends
(none)
`

const CLEAN_MEMORY = `## Rules
short rule
`

function fakeInput(projectID: ProjectID): PluginInput {
  return { project: { id: projectID } } as unknown as PluginInput
}

function fakeStopInput(sessionID: SessionID, supervisorID = "act_test"): SupervisorStopBaseInput {
  return {
    sessionID,
    supervisorID,
    agentType: "checkpoint-writer",
    mode: "subagent",
    lifecycle: "ephemeral",
    task: "checkpoint",
    iteration: 0,
  }
}

// Guards against cross-test leakage of the in-memory CheckpointContext map.
afterEach(() => {
  CheckpointContext._reset()
})

describe("CheckpointSplitoverPlugin (fork behavioral)", () => {
  test("clean checkpoint -> no reentry signal", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    await fs.writeFile(checkpointPath(sessionID), CLEAN_CHECKPOINT)
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["supervisor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    const output: Record<string, unknown> = {}
    await reg.run(fakeStopInput(sessionID), output as never)

    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  test("over-budget checkpoint -> extract-required reentry with EXTRACTION REQUIRED reason", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // Total content far exceeds the 11_000-token checkpoint budget so
    // validateBudget emits severity:"extract-required". The plugin returns on
    // the extract-required branch before any error branch, so the reason is
    // buildExtractionReflection's EXTRACTION REQUIRED message.
    const oversized = `Topic: oversized\n\n### Execution context\n${"x ".repeat(30000)}\n`
    await fs.writeFile(checkpointPath(sessionID), oversized)
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["supervisor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    const output: Record<string, unknown> = {}
    await reg.run(fakeStopInput(sessionID), output as never)

    expect(output.continue).toBe(true)
    expect(typeof output.reason).toBe("string")
    expect((output.reason as string).includes("EXTRACTION REQUIRED")).toBe(true)
  })

  test("empty checkpoint.md -> error branch reentry with reflection paths", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // Empty file => runValidatorsForCkpt emits severity:"error" rule
    // "topic-missing". The plugin takes the error branch and builds a
    // buildReflectionMessage envelope with absolute checkpoint/memory paths.
    await fs.writeFile(checkpointPath(sessionID), "")
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["supervisor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    const output: Record<string, unknown> = {}
    await reg.run(fakeStopInput(sessionID), output as never)

    expect(output.continue).toBe(true)
    expect(typeof output.reason).toBe("string")
    const reason = output.reason as string
    expect(reason.includes("<system-reminder>")).toBe(true)
    expect(reason.includes("CHECKPOINT_PATH = ")).toBe(true)
    expect(reason.includes("MEMORY_PATH     = ")).toBe(true)
  })

  test("matcher restricts the hook to checkpoint-writer agents only", async () => {
    const projectID = tmpProjectID()
    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["supervisor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    const include = (reg.matcher as { agentType?: { include?: string[] } }).agentType?.include ?? []
    expect(include).toContain("checkpoint-writer")
    // Strict include: no other agent type should ever trigger the splitover
    // hook (general/build/summary/custom must be excluded).
    expect(include).toEqual(["checkpoint-writer"])
  })

  test("parentSessionID fallback reads PARENT's checkpoint, not the child's", async () => {
    const parentID = tmpSessionID()
    const childID = tmpSessionID()
    const projectID = tmpProjectID()
    // Provision PARENT's metaDir + a clean checkpoint there. CHILD's metaDir is
    // intentionally NOT created -- proves the plugin reads the parent's path
    // via (parentSessionID ?? sessionID). Without the fallback the plugin
    // would read checkpointPath(child) -> missing -> false topic-missing error.
    await setupSession(parentID, projectID)
    await fs.writeFile(checkpointPath(parentID), CLEAN_CHECKPOINT)
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["supervisor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    // Simulate the post-Axis-A spawn shape: sessionID=child, parentSessionID=parent.
    const output: Record<string, unknown> = {}
    await reg.run({ ...fakeStopInput(childID), parentSessionID: parentID }, output as never)

    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })
})
