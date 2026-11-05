import { expect, test } from "bun:test"
import { SessionPrompt as CoreSessionPrompt } from "@opencode-ai/core/session/prompt"
import { SessionPrompt as AppSessionPrompt } from "@/session/prompt"

test("core and app SessionPrompt copies use distinct service tags", () => {
  expect(CoreSessionPrompt.Service.key).not.toBe(AppSessionPrompt.Service.key)
})
