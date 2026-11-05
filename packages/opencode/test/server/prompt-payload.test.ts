import { expect, test } from "bun:test"
import { Schema } from "effect"
import { PromptPayload } from "@/server/routes/instance/httpapi/groups/session"

test("the public prompt payload cannot set the internal source", () => {
  expect("source" in PromptPayload.fields).toBe(false)

  const payload = Schema.decodeUnknownSync(PromptPayload)({
    parts: [{ type: "text", text: "hi" }],
    source: "hook",
  })
  expect("source" in payload).toBe(false)
})
