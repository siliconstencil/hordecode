import { expect, test } from "bun:test"
import { pickAgent } from "../../src/util/default-agent"

const agents = [{ name: "build" }, { name: "plan" }, { name: "research" }]

test("starts on the first agent without a setting", () => {
  expect(pickAgent({ agents })?.name).toBe("build")
})

test("starts on the configured default agent", () => {
  expect(pickAgent({ agents, configured: "research" })?.name).toBe("research")
})

test("an agent chosen in the session wins over the setting", () => {
  expect(pickAgent({ agents, selected: "plan", configured: "research" })?.name).toBe("plan")
})

test("a default that is not selectable falls back to the first agent", () => {
  expect(pickAgent({ agents, configured: "explore" })?.name).toBe("build")
  expect(pickAgent({ agents, selected: "gone", configured: "gone" })?.name).toBe("build")
})

test("no agents gives no agent", () => {
  expect(pickAgent({ agents: [], configured: "build" })).toBeUndefined()
})
