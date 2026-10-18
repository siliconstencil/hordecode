// Cron tool contract: the tool description and the schedule operation match what
// the scheduler does with recurring jobs.
//
// The scheduler removes a recurring job 7 days after creation (recurringMaxAgeMs)
// unless the job is permanent, and loop jobs end 7 days after they were first armed.
// These are source-level checks of the description and the schedule schema.

import { describe, expect, test } from "bun:test"
import path from "node:path"

const cronDir = path.join(import.meta.dir, "../../../cron/src")
const toolDir = path.join(import.meta.dir, "../../src/tool")
const cronTool = await Bun.file(path.join(toolDir, "cron.ts")).text()
const cronDoc = await Bun.file(path.join(toolDir, "cron.txt")).text()
const scheduler = await Bun.file(path.join(cronDir, "scheduler.ts")).text()

describe("cron tool contract", () => {
  test("cron.txt discloses the 7-day age-out of recurring jobs", () => {
    expect(/7[ -]day|seven days|168 ?h/i.test(cronDoc)).toBe(true)
  })

  test("the schedule operation exposes the permanent flag the scheduler honours", () => {
    expect(cronTool.includes("permanent")).toBe(true)
    expect(scheduler.includes("permanent?: boolean")).toBe(true)
    expect(scheduler.includes("...(input.permanent ? { permanent: true } : {})")).toBe(true)
  })
})
