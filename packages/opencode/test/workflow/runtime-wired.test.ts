import { test, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowNode } from "@/effect/supervisor-node"
import { Database } from "@opencode-ai/core/database/database"
import { Permission } from "@/permission"
import { workflowRef } from "@opencode-ai/workflow/runtime-ref"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"

// Regression: the `workflow` tool resolves its runtime through the
// late-bound workflowRef (tool/workflow.ts:97-103 requireRuntime guard).
// WorkflowRef is populated when the WorkflowRuntime layer body runs, which only
// happens when WorkflowNode is wired into the AppLayer. Before  the node
// was absent, so AppLayer never built the layer and the ref stayed undefined.
// Database.node is included because the Inbox layer (a WorkflowNode dep) runs
// its gc against the storage client at init, which requires the migrated
// `inbox` table -- exactly how the production AppLayer provides it.
test("workflow runtime resolves through AppLayer wiring", async () => {
  const compiled = AppNodeBuilderV1.build(
    LayerNode.group([Permission.node, Database.node, WorkflowNode]),
  )
  const runtime = ManagedRuntime.make(compiled)
  try {
    // Force the layer body to run by touching the service.
    await runtime.runPromise(Effect.gen(function* () {
      yield* WorkflowRuntime.Service
    }))
    expect(workflowRef.current).toBeDefined()
  } finally {
    await runtime.dispose()
  }
})
