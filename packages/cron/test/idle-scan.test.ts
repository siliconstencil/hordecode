import { describe, expect, test } from "bun:test"
import { createIdleScanGate } from "../src/idle-scan"

describe("createIdleScanGate", () => {
  test("scans every tick until a scan has found nothing", () => {
    const gate = createIdleScanGate(5)
    expect([gate.shouldScan(), gate.shouldScan(), gate.shouldScan()]).toEqual([true, true, true])
  })

  test("after an empty scan only every fifth tick scans", () => {
    const gate = createIdleScanGate(5)
    gate.record(0)
    const scans = Array.from({ length: 10 }, () => gate.shouldScan())
    expect(scans).toEqual([false, false, false, false, true, false, false, false, false, true])
  })

  test("a scan that finds tasks restores every-tick scanning", () => {
    const gate = createIdleScanGate(5)
    gate.record(0)
    gate.shouldScan()
    gate.record(2)
    expect(Array.from({ length: 4 }, () => gate.shouldScan())).toEqual([true, true, true, true])
  })

  test("wake makes the very next tick scan and restarts the count", () => {
    const gate = createIdleScanGate(5)
    gate.record(0)
    gate.shouldScan()
    gate.shouldScan()
    gate.wake()
    expect(gate.shouldScan()).toBe(true)
    gate.record(0)
    expect(Array.from({ length: 5 }, () => gate.shouldScan())).toEqual([false, false, false, false, true])
  })
})
