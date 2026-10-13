import { test, expect } from "bun:test"
import { Effect, ManagedRuntime, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session as CoreSession } from "@opencode-ai/core/session"
import { Session as OpenSession } from "@/session/session"

//  service-identity: Effect Context keys services by tag STRING, not class
// identity. The workflow runtime yields core services ("@opencode/Provider",
// "@opencode/Config", ...); AppLayer provides opencode-side nodes with the same key
// strings. This pins that the bridge works: providing the opencode Session node
// satisfies a core Session.Service yield at runtime. The `as never` cast on the
// probe erases the core-service type requirement, which the opencode-provided
// layer satisfies at runtime via the shared tag key.
test("opencode Session layer satisfies core Session.Service yield", async () => {
  const compiled = LayerNode.compile(LayerNode.group([OpenSession.node]))
  const runtime = ManagedRuntime.make(compiled as unknown as Layer.Layer<never, never, never>)
  try {
    const probe = Effect.gen(function* () {
      const core = yield* CoreSession.Service
      return typeof core === "object"
    }) as never
    const result = await runtime.runPromise(probe)
    expect(result).toBe(true)
  } finally {
    await runtime.dispose()
  }
})
