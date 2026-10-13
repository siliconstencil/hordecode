import { test, expect } from "bun:test"
import { Effect, ManagedRuntime, Layer } from "effect"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowNode } from "@/effect/supervisor-node"
import { Permission } from "@/permission"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"

//  WorkflowNode compiles against AppLayer-shaped deps without leaving
// unbound layer nodes, and the WorkflowRuntime service itself resolves (its
// layer populates workflowRef at build time, see runtime-wired.test.ts).
test("WorkflowNode compiles and WorkflowRuntime resolves", async () => {
  const compiled = AppNodeBuilderV1.build(LayerNode.group([Permission.node, WorkflowNode]))
  const runtime = ManagedRuntime.make(compiled as unknown as Layer.Layer<never, never, never>)
  try {
    const probe = Effect.gen(function* () {
      const rt = yield* WorkflowRuntime.Service
      return typeof rt === "object"
    }) as never
    const result = await runtime.runPromise(probe)
    expect(result).toBe(true)
  } finally {
    await runtime.dispose()
  }
})
