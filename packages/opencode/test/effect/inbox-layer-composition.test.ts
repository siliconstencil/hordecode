import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Inbox } from "@opencode-ai/inbox"
import { Session } from "@/session/session"

// ============================================================================
// Three-tier layer composition TDZ reproduction test
// Rule: speculative fixes FORBIDDEN. Only observe and report.
// ============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function tryBuildLayer(layer: Layer.Layer<any, any>, label: string): Promise<"OK" | "TDZ" | "ERROR"> {
  try {
    const rt = ManagedRuntime.make(layer)
    await rt.runPromise(
      Effect.gen(function* () {
        yield* Inbox.Service
      }),
    )
    return "OK"
  } catch (err) {
    if (err instanceof ReferenceError) {
      return "TDZ"
    }
    // Non-TDZ errors are expected (MissingService, init failures, unbound nodes)
    return "ERROR"
  }
}

// ---------------------------------------------------------------------------
// Recreate InboxNode (match tool/registry.ts:488-492 exactly)
// ---------------------------------------------------------------------------
const InboxNode = makeGlobalNode({
  service: Inbox.Service,
  layer: Inbox.defaultLayer as unknown as Layer.Layer<Inbox.Service, never, never>,
  deps: [],
})

// ============================================================================
// Test C -- Direct Inbox.defaultLayer (no LayerNode involvement)
// ============================================================================
test("Test C: direct Inbox.defaultLayer", async () => {
  const result = await tryBuildLayer(Inbox.defaultLayer, "Test C")
  expect(result).not.toBe("TDZ")
})

// ============================================================================
// Test B -- Minimal LayerNode compile: InboxNode + Session.node
// ============================================================================
// Uses opencode's Session.node (from @/session/session) which is what
// AppLayer uses. Different from core's SessionV2.node (which has dep on
// SessionExecution, an unbound node).
test("Test B: InboxNode + Session.node group", async () => {
  const group = LayerNode.group([InboxNode, Session.node])
  let layer: Layer.Layer<any, any>
  try {
    layer = AppNodeBuilderV1.build(group)
  } catch (err) {
    if (err instanceof ReferenceError) {
      throw new Error(`F1 REPRODUCED at compile time (Test B): ${err.message}`)
    }
    // Non-TDZ compile error (unbound node, etc.)
    console.log(`[Test B] Compile error (not TDZ): ${String(err).slice(0, 200)}`)
    expect(true).toBe(true)
    return
  }

  const result = await tryBuildLayer(layer, "Test B")
  expect(result).not.toBe("TDZ")
})

// ============================================================================
// Test A -- Full AppLayer reproduction
// ============================================================================
test("Test A: import AppLayer from app-runtime.ts", async () => {
  let AppLayer: Layer.Layer<any, any>
  try {
    const mod = await import("../../src/effect/app-runtime")
    AppLayer = mod.AppLayer
  } catch (err) {
    if (err instanceof ReferenceError) {
      throw new Error(`F1 REPRODUCED at app-runtime.ts import time (Test A): ${err.message}`)
    }
    console.log(`[Test A] Import error (not TDZ): ${String(err).slice(0, 200)}`)
    expect(true).toBe(true)
    return
  }

  const result = await tryBuildLayer(AppLayer, "Test A")
  expect(result).not.toBe("TDZ")
})
