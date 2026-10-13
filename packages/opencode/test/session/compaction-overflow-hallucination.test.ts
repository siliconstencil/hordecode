// Regression: native (non-DCP) compaction must never fabricate a cause
// that was not present in the compacted conversation. In particular, when an
// overflow triggers compaction, the auto-injected follow-up message must only
// claim "large media attachments" when the conversation actually contained
// media -- otherwise it hallucinates (upstream compaction.ts:465
// unconditionally blamed media on every overflow; fork ported it verbatim).
import { describe, expect, it } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { buildCompactContinueText, conversationHadMedia } from "../../src/session/compaction"

// Minimal real-shaped messages: conversationHadMedia only inspects `parts`, so
// the projection's `info` is irrelevant here and kept minimal.
const msg = (parts: SessionV1.Part[]): SessionV1.WithParts =>
  ({ info: { role: "user" } as SessionV1.Info, parts }) as unknown as SessionV1.WithParts

const textPart = (text: string): SessionV1.Part => ({ type: "text", text }) as unknown as SessionV1.Part

const filePart = (mime: string): SessionV1.Part => ({ type: "file", mime, url: "file:///x" }) as unknown as SessionV1.Part

describe("native compaction overflow follow-up never fabricates absent content", () => {
  it("does not claim media attachments when the conversation had none (overflow path)", () => {
    const messages = [msg([textPart("just a plain text question")]), msg([textPart("and a plain reply")])]
    const hadMedia = conversationHadMedia(messages)
    expect(hadMedia).toBe(false)
    const text = buildCompactContinueText({ overflow: true, hadMedia })
    expect(text).not.toContain("media attachments")
    expect(text).toContain("Continue if you have next steps")
  })

  it("still explains media when the conversation genuinely contained media (overflow path)", () => {
    const messages = [msg([textPart("here is a screenshot"), filePart("image/png")])]
    const hadMedia = conversationHadMedia(messages)
    expect(hadMedia).toBe(true)
    const text = buildCompactContinueText({ overflow: true, hadMedia })
    expect(text).toContain("media attachments")
  })

  it("does not mention a size limit or media on the non-overflow (auto) path", () => {
    const messages = [msg([textPart("plain")])]
    const hadMedia = conversationHadMedia(messages)
    const text = buildCompactContinueText({ overflow: false, hadMedia })
    expect(text).not.toContain("media attachments")
    expect(text).not.toContain("provider's size limit")
    expect(text).toContain("Continue if you have next steps")
  })
})
