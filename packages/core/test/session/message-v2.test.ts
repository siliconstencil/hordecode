import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Model as ProviderModel } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const SESSION_ID = SessionID.zod.parse("ses_message_v2")
const MESSAGE_ID = MessageID.zod.parse("msg_message_v2")

const model = ProviderModel.zod.parse({
  id: "test-model",
  providerID: "test",
  api: { id: "test", url: "http://localhost", npm: "@ai-sdk/test" },
  name: "test-model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

function basePart(id: string) {
  return {
    id: PartID.zod.parse(`prt_${id}`),
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
  }
}

function userInfo(): MessageV2.User {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 0 },
    agent: "user",
  }
}

type Shape = {
  name: string
  part: MessageV2.Part
  substantive: boolean
  sent: boolean
  sentText?: string
}

// The one rule: a user text part carries content iff it is not ignored and its
// length is greater than zero (length, not trim). Files count unless their mime
// is text/plain or application/x-directory.
const shapes: Shape[] = [
  {
    name: "text hello",
    part: { ...basePart("p1"), type: "text", text: "hello" },
    substantive: true,
    sent: true,
    sentText: "hello",
  },
  {
    name: "text whitespace only",
    part: { ...basePart("p1"), type: "text", text: "   " },
    substantive: true,
    sent: true,
    sentText: "   ",
  },
  {
    name: "text empty",
    part: { ...basePart("p1"), type: "text", text: "" },
    substantive: false,
    sent: false,
  },
  {
    name: "text ignored",
    part: { ...basePart("p1"), type: "text", text: "ignored", ignored: true },
    substantive: false,
    sent: false,
  },
  {
    name: "file image/png",
    part: {
      ...basePart("p1"),
      type: "file",
      mime: "image/png",
      filename: "img.png",
      url: "https://example.com/img.png",
    },
    substantive: true,
    sent: true,
  },
  {
    name: "file text/plain",
    part: {
      ...basePart("p1"),
      type: "file",
      mime: "text/plain",
      filename: "note.txt",
      url: "https://example.com/note.txt",
    },
    substantive: false,
    sent: false,
  },
]

describe("session.message-v2", () => {
  test("hasSubstantiveContent counts a user part only when it carries content", () => {
    for (const shape of shapes) {
      const substantive = MessageV2.hasSubstantiveContent([shape.part])

      expect({ shape: shape.name, substantive }).toStrictEqual({
        shape: shape.name,
        substantive: shape.substantive,
      })
    }
  })

  test("the send side drops empty text parts and keeps whitespace-only ones", async () => {
    for (const shape of shapes) {
      const sent = await Effect.runPromise(
        MessageV2.toModelMessagesEffect([{ info: userInfo(), parts: [shape.part] }], model),
      )

      expect({ shape: shape.name, sent: sent.length > 0 }).toStrictEqual({
        shape: shape.name,
        sent: shape.sent,
      })

      if (shape.sentText !== undefined) {
        expect(sent[0].content).toStrictEqual([{ type: "text", text: shape.sentText }])
      }
    }
  })
})
