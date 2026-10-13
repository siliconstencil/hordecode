/**
 * memory-path-guard regression tests.
 *
 * Verifies write-boundary sandbox enforcement for system agents:
 * - checkpoint-writer: memory-only
 * - dream/distill: memory + .hordecode config directory
 * - main agent: cannot write checkpoint-writer-reserved paths
 *
 * Fork source: packages/core/src/tool/memory-path-guard.ts
 */
import { describe, expect, test } from "bun:test"
import {
  assertAgentWriteSandbox,
  assertMemoryWriteAllowed,
} from "../memory-path-guard"

const MEMORY_ROOT = "/home/user/.local/share/hordecode/memory"
const WORKTREE = "/home/user/project"
const PROJECT_ID = "proj_abc" as any
const SESSION_ID = "ses_xyz" as any

describe("assertAgentWriteSandbox", () => {
  describe("checkpoint-writer is memory-only", () => {
    test("allows write inside memory root", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${MEMORY_ROOT}/projects/proj/MEMORY.md`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).not.toThrow()
    })

    test("blocks write outside memory root (source file)", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).toThrow(/may only write under the memory tree/)
    })

    test("blocks write to .hordecode config dir", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/.hordecode/config.json`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).toThrow(/may only write under the memory tree/)
    })

    test("blocks path traversal escape via ..", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${MEMORY_ROOT}/../src/evil.ts`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).toThrow(/may only write under the memory tree/)
    })
  })

  describe("dream and distill have memory + config sandbox", () => {
    test("dream allows write inside memory root", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${MEMORY_ROOT}/projects/proj/MEMORY.md`,
          agentName: "dream",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).not.toThrow()
    })

    test("dream allows write inside .hordecode config dir", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/.hordecode/skill.md`,
          agentName: "dream",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).not.toThrow()
    })

    test("dream blocks write to source files", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "dream",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).toThrow(/may only write under the memory tree or/)
    })

    test("distill has same sandbox as dream", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "distill",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).toThrow(/may only write under the memory tree or/)
    })
  })

  describe("non-sandboxed agents pass through", () => {
    test("build agent is not sandboxed", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).not.toThrow()
    })

    test("general agent is not sandboxed", () => {
      expect(() =>
        assertAgentWriteSandbox({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "general",
          memoryRoot: MEMORY_ROOT,
          worktree: WORKTREE,
        }),
      ).not.toThrow()
    })
  })
})

describe("assertMemoryWriteAllowed", () => {
  const memoryFile = `${MEMORY_ROOT}/projects/${PROJECT_ID}/MEMORY.md`
  const checkpointFile = `${MEMORY_ROOT}/sessions/${SESSION_ID}/checkpoint.md`
  const notesFile = `${MEMORY_ROOT}/sessions/${SESSION_ID}/notes.md`
  const taskDir = `${MEMORY_ROOT}/sessions/${SESSION_ID}/tasks`

  describe("checkpoint-writer allowlist", () => {
    test("allows projects/<pid>/MEMORY.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: memoryFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("allows sessions/<sid>/checkpoint.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: checkpointFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("allows sessions/<sid>/notes.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: notesFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("allows tasks/<TID>/<file>.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${taskDir}/T42/progress.md`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("allows checkpoint spillover checkpoint-<topic>.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${MEMORY_ROOT}/sessions/${SESSION_ID}/checkpoint-decisions.md`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("blocks projects/<pid>/pinned.md (v4 name drift)", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${MEMORY_ROOT}/projects/${PROJECT_ID}/pinned.md`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/not in the checkpoint-writer allowlist/)
    })

    test("blocks tasks/<TID>/.md with invalid task ID", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${taskDir}/not-a-task-id/progress.md`,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/not in the checkpoint-writer allowlist/)
    })
  })

  describe("main agent reserved paths", () => {
    test("main agent can write projects/<pid>/MEMORY.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: memoryFile,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("main agent can write sessions/<sid>/notes.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: notesFile,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("main agent cannot write tasks/<TID> (reserved for checkpoint-writer)", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${taskDir}/T1/progress.md`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/reserved for the checkpoint-writer subagent/)
    })

    test("subagent bound to TID can write its own tasks/<TID>/*.md", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${taskDir}/T42/progress.md`,
          agentName: "general",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          taskId: "T42",
        }),
      ).not.toThrow()
    })

    test("subagent bound to T1 cannot write tasks/T2", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${taskDir}/T2/progress.md`,
          agentName: "general",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          taskId: "T1",
        }),
      ).toThrow(/reserved for the checkpoint-writer subagent/)
    })
  })

  describe("scope validation", () => {
    test("rejects writes with invalid scope", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${MEMORY_ROOT}/invalid/scope/file.md`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/scope/)
    })

    test("rejects writes directly under memory root (no scope)", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${MEMORY_ROOT}/file.md`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow()
    })

    test("non-memory paths pass through unmodified", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })
  })

  describe("writeEnabled switch", () => {
    test("writeEnabled: false refuses all memory writes regardless of agent or path", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: memoryFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          writeEnabled: false,
        }),
      ).toThrow("Memory WRITING is disabled")
    })

    test("writeEnabled: false refuses non-checkpoint-writer memory writes", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${MEMORY_ROOT}/projects/${PROJECT_ID}/custom.md`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          writeEnabled: false,
        }),
      ).toThrow("Memory WRITING is disabled")
    })

    test("writeEnabled: true allows memory writes normally", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: memoryFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          writeEnabled: true,
        }),
      ).not.toThrow()
    })

    test("omitted writeEnabled defaults to enabled", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: memoryFile,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("writeEnabled: false still allows non-memory paths", () => {
      expect(() =>
        assertMemoryWriteAllowed({
          target: `${WORKTREE}/src/index.ts`,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
          writeEnabled: false,
        }),
      ).not.toThrow()
    })
  })
})
