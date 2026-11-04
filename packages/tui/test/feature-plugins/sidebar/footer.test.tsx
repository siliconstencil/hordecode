import { afterEach, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import plugin from "../../../src/feature-plugins/sidebar/footer"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

test("getting started copy does not claim free models or name competitors", async () => {
  let slot: (() => JSX.Element) | undefined
  const color = RGBA.fromInts(200, 200, 200)
  const api = {
    theme: { current: new Proxy({}, { get: () => color }) },
    state: { provider: [], path: { directory: "/work/example" }, vcs: undefined },
    kv: { get: () => false, set: () => {} },
    app: { version: "0.1.6" },
    slots: {
      register(input: { slots: { sidebar_footer: () => JSX.Element } }) {
        slot = input.slots.sidebar_footer
      },
    },
  } as unknown as TuiPluginApi

  await (plugin.tui as (api: TuiPluginApi) => Promise<void>)(api)
  expect(slot).toBeDefined()

  testSetup = await testRender(slot!, { width: 90, height: 20 })
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  const frame = testSetup.captureCharFrame()

  expect(frame).toContain("Connect a provider")
  expect(frame).not.toContain("free models")
  expect(frame).not.toContain("Claude")
  expect(frame).not.toContain("GPT")
  expect(frame).not.toContain("Gemini")
})
