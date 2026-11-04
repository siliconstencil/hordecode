import { Effect } from "effect"
import { expect } from "bun:test"
import { it, measure } from "../lib/tool-cost-harness"

// The orchestrator agent exists only when this switch is on; flags are read at use, so setting it here is enough.
process.env["HORDECODE_EXPERIMENTAL_ORCHESTRATOR"] = "1"

const names = (cost: { tools: { name: string }[] }) => cost.tools.map((tool) => tool.name)

it.instance("session tool is sent to the orchestrator agent", () =>
  Effect.gen(function* () {
    const cost = yield* measure("orchestrator", "orchestrator")
    expect(names(cost)).toContain("session")
  }),
)

it.instance("session tool is not sent to build, plan or a supervisor child", () =>
  Effect.gen(function* () {
    for (const agent of ["build", "plan"]) {
      const cost = yield* measure(`gating-${agent}`, agent)
      expect(names(cost)).not.toContain("session")
      // the other orchestration tools stay
      expect(names(cost)).toContain("supervisor")
      expect(names(cost)).toContain("workflow")
    }
    const child = yield* measure("gating-child", "general", "act_gate")
    expect(names(child)).not.toContain("session")
  }),
)
