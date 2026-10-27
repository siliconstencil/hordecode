import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "../../../src/session/message-v2"
import { renderDisplay } from "../../../src/session/advisor/run"

// The advisor's on-screen part is stored on the step's assistant message as an ignored text part.
// It must never reach a model: the model sees the notes once, through the per-step reminder.

const providerID = ProviderV2.ID.make("test")
const model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as unknown as Provider.Model

function conversation(withAdvisor: boolean): SessionV1.WithParts[] {
  const part = (messageID: string, id: string) => ({ id: `prt_${id}`, sessionID: "ses_a", messageID })
  const advisorPart = {
    ...part("msg_b", "adv"),
    type: "text",
    text: renderDisplay([{ severity: "concern", note: "Read the error before retrying." }], ["tool_failures 2 >= 2"]),
    synthetic: true,
    ignored: true,
    metadata: { advisor: { notes: [{ severity: "concern", note: "Read the error before retrying." }], reasons: [] } },
  }
  return [
    {
      info: { id: "msg_a", sessionID: "ses_a", role: "user", time: { created: 0 }, agent: "build", model: { providerID, modelID: model.id } },
      parts: [{ ...part("msg_a", "u1"), type: "text", text: "fix the build" }],
    },
    {
      info: {
        id: "msg_b",
        sessionID: "ses_a",
        role: "assistant",
        time: { created: 1 },
        parentID: "msg_a",
        modelID: model.id,
        providerID,
        mode: "",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [...(withAdvisor ? [advisorPart] : []), { ...part("msg_b", "t1"), type: "text", text: "Retrying." }],
    },
  ] as unknown as SessionV1.WithParts[]
}

describe("advisor display part", () => {
  test("is not replayed to the model", async () => {
    const without = await MessageV2.toModelMessages(conversation(false), model)
    const withPart = await MessageV2.toModelMessages(conversation(true), model)
    expect(withPart).toStrictEqual(without)
    expect(JSON.stringify(withPart)).not.toContain("Read the error before retrying")
  })

  test("an aborted step that holds only the advisor part is skipped like an empty one", async () => {
    // Esc right after the advisor fired: the step has step-start plus the advisor part and an abort error.
    const aborted = new SessionV1.AbortedError({ message: "aborted" }).toObject()
    const step = (withAdvisor: boolean) => {
      const msgs = conversation(withAdvisor)
      const assistant = msgs[1]
      ;(assistant.info as { error?: unknown }).error = aborted
      assistant.parts = [
        { id: "prt_s0", sessionID: "ses_a", messageID: "msg_b", type: "step-start" },
        ...assistant.parts.filter((p) => p.type === "text" && p.ignored),
      ] as unknown as SessionV1.WithParts["parts"]
      return msgs
    }
    expect(await MessageV2.toModelMessages(step(true), model)).toStrictEqual(
      await MessageV2.toModelMessages(step(false), model),
    )
  })

  test("renderDisplay lists the notes, or says the review found none", () => {
    expect(renderDisplay([{ severity: "blocker", note: "Edits outside the task." }], ["files_touched 9 >= 8"])).toBe(
      "Advisor (files_touched 9 >= 8):\n- [blocker] Edits outside the task.",
    )
    expect(renderDisplay([], ["same_error 2 >= 2"])).toBe("Advisor reviewed this step (same_error 2 >= 2): no notes.")
    expect(renderDisplay([], ["same_error 2 >= 2"], "rate limited")).toBe(
      "Advisor review failed (same_error 2 >= 2): rate limited",
    )
  })
})
