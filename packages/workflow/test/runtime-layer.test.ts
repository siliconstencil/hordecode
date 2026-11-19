import { describe, expect, test } from "bun:test"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"

// K5: N5. The runtime's project-script gate is mandatory at the type level, so a
// future caller cannot construct a gate-free layer that resolves every saved
// project workflow. The call below is never executed; the compiler is the assertion.
// @ts-expect-error projectScriptGate is required
const ungated = () => WorkflowRuntime.layer()

describe("workflow runtime layer", () => {
  test("the runtime layer requires a project-script gate", () => {
    expect(typeof ungated).toBe("function")
    expect(typeof WorkflowRuntime.layer).toBe("function")
  })
})
