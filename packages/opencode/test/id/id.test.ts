import { expect, test } from "bun:test"
import { Identifier } from "@/id/id"

test("id generation delegates to the canonical schema identifier", async () => {
  const source = await Bun.file(new URL("../../src/id/id.ts", import.meta.url)).text()
  expect(source).toContain("@opencode-ai/schema/identifier")
  expect(source).not.toContain('from "crypto"')
})

test("ids keep the prefixed v2 format and timestamp", () => {
  const id = Identifier.create("ses", "ascending", 1_700_000_000_000)
  expect(id.startsWith("ses_")).toBe(true)
  expect(id).toHaveLength("ses_".length + 26)
  expect(Identifier.timestamp(id)).toBe(1_700_000_000_000)
})
