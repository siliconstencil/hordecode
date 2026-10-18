// Tool descriptions match what the code does. Source-level checks.

import { describe, expect, test } from "bun:test"
import path from "node:path"

const toolDir = path.join(import.meta.dir, "../../src/tool")
const memoryDir = path.join(import.meta.dir, "../../../memory/src")

const recallSource = await Bun.file(path.join(toolDir, "memory-recall.ts")).text()
const sessionTool = await Bun.file(path.join(toolDir, "session.ts")).text()
const sessionDoc = await Bun.file(path.join(toolDir, "session.txt")).text()
const supervisorDoc = await Bun.file(path.join(toolDir, "supervisor.txt")).text()
const memoryService = await Bun.file(path.join(memoryDir, "service.ts")).text()

describe("tool description contracts", () => {
  test("memory_recall does not claim adaptive IDF, which this build does not run", () => {
    // The memory service states that fts5vocab is absent and uses flat weight 1.
    expect(memoryService.includes("fts5vocab virtual table is not available")).toBe(true)
    expect(recallSource.includes("adaptive IDF")).toBe(false)
    expect(recallSource.includes("flat term weighting")).toBe(true)
  })

  test("session list doc matches the list output", () => {
    const listDocLine = sessionDoc.split("\n").find((line) => line.includes("- list:")) ?? ""
    // Child-session list output (session.ts): one line per child, `${id} -- ${title}`.
    const listOutputLine = sessionTool.split("\n").find((line) => line.includes("c.id} -- ${c.title}")) ?? ""
    expect(listOutputLine.length).toBeGreaterThan(0)
    expect(listDocLine.includes("id -- title")).toBe(true)
    const docPromisesMode = listDocLine.includes("mode")
    const outputCarriesMode = listOutputLine.includes("mode")
    expect(docPromisesMode && !outputCarriesMode).toBe(false)
  })

  test("supervisor operation list names every valid action, including models", () => {
    const opsStart = supervisorDoc.indexOf("## Operations")
    const opsEnd = supervisorDoc.indexOf("## When to use")
    expect(opsStart).toBeGreaterThanOrEqual(0)
    expect(opsEnd).toBeGreaterThan(opsStart)
    const opsSection = supervisorDoc.slice(opsStart, opsEnd)
    expect(opsSection.includes("- models:")).toBe(true)
  })
})
