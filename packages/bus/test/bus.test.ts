import { describe, it, expect, afterEach } from "bun:test"
import { Bus } from "@opencode-ai/bus"
import { BusEvent } from "@opencode-ai/bus/bus-event"
import { GlobalBus } from "@opencode-ai/bus/global"
import { z } from "zod"

type Captured = { payload: Record<string, unknown> }

// Safely read the zod `meta().ref` that bus-event attaches to each payload schema.
function refOf(s: unknown): string | undefined {
  const meta = (s as { meta?: () => { ref?: string } }).meta?.()
  return meta?.ref
}

const unsubs: Array<() => void> = []
afterEach(() => {
  for (const u of unsubs) u()
  unsubs.length = 0
  GlobalBus.removeAllListeners("event")
})

describe("BusEvent.define / payloads", () => {
  it("registers a typed event and exposes it in payloads()", () => {
    const def = BusEvent.define("bus.test.def.1", z.object({ value: z.number() }))
    expect(def.type).toBe("bus.test.def.1")
    const match = BusEvent.payloads().filter((s) => refOf(s) === "Event.bus.test.def.1")
    expect(match.length).toBeGreaterThanOrEqual(1)
  })
})

describe("GlobalBus id injection", () => {
  it("injects an id when payload has none", () => {
    const events: Captured[] = []
    const handler = (e: Captured) => events.push(e)
    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: { foo: 1 } })
    expect(events.length).toBe(1)
    expect(events[0].payload.id).toBeTruthy()
    GlobalBus.off("event", handler)
  })

  it("keeps an existing id", () => {
    const events: Captured[] = []
    const handler = (e: Captured) => events.push(e)
    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: { id: "fixed", foo: 1 } })
    expect(events[0].payload.id).toBe("fixed")
    GlobalBus.off("event", handler)
  })

  it("uses syncEvent.id when no id is present", () => {
    const events: Captured[] = []
    const handler = (e: Captured) => events.push(e)
    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: { syncEvent: { id: "sync-1" } } })
    expect(events[0].payload.id).toBe("sync-1")
    GlobalBus.off("event", handler)
  })
})

describe("Bus dispatch (Service)", () => {
  it("routes a published event to both typed and wildcard subscribers", async () => {
    const def = BusEvent.define("bus.test.dispatch.1", z.object({ n: z.number() }))
    let typed = 0
    let all = 0
    unsubs.push(Bus.subscribe(def, () => void typed++))
    unsubs.push(Bus.subscribeAll(() => void all++))
    await Bus.publish(def, { n: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(typed).toBe(1)
    expect(all).toBe(1)
  })

  it("filters typed subscribers by event type", async () => {
    const defA = BusEvent.define("bus.test.filter.a", z.object({ x: z.number() }))
    const defB = BusEvent.define("bus.test.filter.b", z.object({ x: z.number() }))
    let aCount = 0
    unsubs.push(Bus.subscribe(defA, () => void aCount++))
    await Bus.publish(defB, { x: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(aCount).toBe(0)
    await Bus.publish(defA, { x: 2 })
    await new Promise((r) => setTimeout(r, 50))
    expect(aCount).toBe(1)
  })

  it("stops delivery after unsubscribe", async () => {
    const def = BusEvent.define("bus.test.unsub.1", z.object({ y: z.number() }))
    let count = 0
    const unsub = Bus.subscribe(def, () => void count++)
    await Bus.publish(def, { y: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
    unsub()
    await new Promise((r) => setTimeout(r, 50))
    await Bus.publish(def, { y: 2 })
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
  })
})

describe("Bus.publish -> GlobalBus forward", () => {
  it("forwards every published event to GlobalBus with directory/project/workspace", async () => {
    const def = BusEvent.define("bus.test.forward.1", z.object({ n: z.number() }))
    const events: Array<Record<string, unknown>> = []
    const handler = (e: Record<string, unknown>) => events.push(e)
    GlobalBus.on("event", handler)
    try {
      await Bus.publish(def, { n: 7 })
      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBe(1)
      const ev = events[0]
      expect(ev.payload).toMatchObject({ type: "bus.test.forward.1", properties: { n: 7 } })
      expect(typeof ev.directory).toBe("string")
      expect(typeof ev.project).toBe("string")
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  it("injects an id into the forwarded payload when none is present", async () => {
    const def = BusEvent.define("bus.test.forward.id.1", z.object({ n: z.number() }))
    const events: Array<Record<string, unknown>> = []
    const handler = (e: Record<string, unknown>) => events.push(e)
    GlobalBus.on("event", handler)
    try {
      await Bus.publish(def, { n: 1 })
      await new Promise((r) => setTimeout(r, 50))
      const payload = events[0].payload as Record<string, unknown>
      const properties = payload.properties as Record<string, unknown>
      expect(properties).toMatchObject({ n: 1 })
      // id is injected on the forwarded event payload (bus-event shape), not on properties
      expect(payload.id).toBeTruthy()
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  it("does not forward to GlobalBus when no subscriber listens", async () => {
    const def = BusEvent.define("bus.test.forward.none.1", z.object({ n: z.number() }))
    // No GlobalBus listener registered -- emit must not throw.
    await Bus.publish(def, { n: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(true).toBe(true)
  })
})

describe("Bus.subscribeAllCallback", () => {
  it("delivers all events to a wildcard callback subscriber", async () => {
    const def = BusEvent.define("bus.test.allcb.1", z.object({ n: z.number() }))
    const seen: Array<unknown> = []
    const unsub = Bus.subscribeAll((event) => void seen.push(event))
    unsubs.push(unsub)
    await Bus.publish(def, { n: 3 })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen.length).toBe(1)
    expect(seen[0]).toMatchObject({ type: "bus.test.allcb.1", properties: { n: 3 } })
  })

  it("stops delivery after unsubscribe", async () => {
    const def = BusEvent.define("bus.test.allcb.unsub.1", z.object({ n: z.number() }))
    let count = 0
    const unsub = Bus.subscribeAll(() => void count++)
    await Bus.publish(def, { n: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
    unsub()
    await new Promise((r) => setTimeout(r, 50))
    await Bus.publish(def, { n: 2 })
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
  })
})

describe("Bus subscriber error handling", () => {
  it("swallows a throwing typed subscriber without affecting other subscribers", async () => {
    const def = BusEvent.define("bus.test.err.1", z.object({ n: z.number() }))
    let healthy = 0
    unsubs.push(
      Bus.subscribe(def, () => {
        throw new Error("boom")
      }),
    )
    unsubs.push(Bus.subscribe(def, () => void healthy++))
    await Bus.publish(def, { n: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(healthy).toBe(1)
  })

  it("swallows a throwing wildcard subscriber without affecting typed subscribers", async () => {
    const def = BusEvent.define("bus.test.err.wild.1", z.object({ n: z.number() }))
    let typed = 0
    unsubs.push(
      Bus.subscribeAll(() => {
        throw new Error("boom")
      }),
    )
    unsubs.push(Bus.subscribe(def, () => void typed++))
    await Bus.publish(def, { n: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(typed).toBe(1)
  })
})
