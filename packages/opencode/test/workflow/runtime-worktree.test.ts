import { expect } from "bun:test"
import { Effect } from "effect"
import { ProviderID, ModelID } from "@opencode-ai/core/provider/schema"
import { Session } from "@/session/session"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { provideTmpdirServer } from "../fixture/fixture"
import { itWorkflow as it, providerCfg } from "../lib/tool-cost-harness"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// The workflow runtime gets its Worktree service from the opencode layer
// (WorkflowNode deps). This proves the opencode implementation covers the
// create -> head -> isPristine -> remove path the runtime uses for isolation.
it.live(
  "a workflow agent worktree is created, headed, and reclaimed through the opencode service",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate clean",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.text("done")
        // A worktree checks out HEAD only; commit the fixture provider config so
        // the isolated Instance can resolve the test provider.
        yield* Effect.promise(() => Bun.$`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())

        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("look", { isolation: "worktree" })`,
        ].join("\n")
        const { runID } = yield* runtime.start({
          script,
          sessionID: parent.id,
          parentSupervisorID: "main",
          model: ref,
        })
        const outcome = yield* runtime.wait({ runID })

        expect(outcome.status).toBe("completed")
        // Untouched (pristine) -> the runtime heads, sees no change, and removes it.
        expect((outcome as { result: any }).result).toBe("done")
        expect((outcome as { result: any }).result?._worktree).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  30000,
)
