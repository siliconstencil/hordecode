import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
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


describe("session.message-v2.boundImages", () => {
  // P196: opencode v1.19.6 packages/opencode/test/session/message-v2.test.ts:1622-1710
  const image = (mib: number, filename: string): ModelMessage => ({
    role: "user",
    content: [{ type: "file", mediaType: "image/png", filename, data: "a".repeat(mib * 1024 * 1024) }],
  })
  const removed = (messages: ModelMessage[]) =>
    messages.filter((message) => (message.content as Array<{ type: string }>)[0]?.type === "text").length

  test("preserves images below the trigger", () => {
    const messages = [image(1, "small.png")]
    expect(MessageV2.boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const text: ModelMessage = { role: "user", content: [{ type: "text", text: "plain" }] }
    const third = image(9, "third.png")
    const messages = [image(9, "first.png"), text, image(9, "second.png"), third]
    const result = MessageV2.boundImages(messages)
    expect(result[0]?.content).toEqual([{ type: "text", text: expect.stringContaining("image was removed") }])
    expect(result[1]).toBe(text)
    expect(result[2]?.content).toEqual([{ type: "text", text: expect.stringContaining("image was removed") }])
    expect(result[3]).toBe(third)
  })

  test("keeps the replaced prefix stable as new images arrive, so the prompt cache survives", () => {
    const history = Array.from({ length: 9 }, (_, i) => image(3, `${i}.png`))
    expect(removed(MessageV2.boundImages(history))).toBe(4)
    expect(removed(MessageV2.boundImages([...history, image(3, "9.png")]))).toBe(4)
    expect(removed(MessageV2.boundImages([...history, ...[9, 10, 11].map((i) => image(3, `${i}.png`))]))).toBe(4)
    expect(removed(MessageV2.boundImages([...history, ...[9, 10, 11, 12].map((i) => image(3, `${i}.png`))]))).toBe(8)
  })

  test("replaces images nested in tool results", () => {
    const data = "a".repeat(13 * 1024 * 1024)
    const result = MessageV2.boundImages([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "media", mediaType: "image/png", data },
                { type: "media", mediaType: "image/png", data },
              ],
            },
          },
        ],
      },
    ])
    expect(result[0]?.content).toMatchObject([
      {
        type: "tool-result",
        output: { type: "content", value: [{ type: "text" }, { type: "media", mediaType: "image/png" }] },
      },
    ])
  })

  test("bounds tool-result images re-sent as synthetic user messages", async () => {
    const compatible: ProviderModel = {
      ...model,
      api: { ...model.api, npm: "@ai-sdk/openai-compatible" },
      capabilities: { ...model.capabilities, attachment: true, input: { ...model.capabilities.input, image: true } },
    }
    const userID = MessageID.zod.parse("msg_bound_user")
    const assistant = (id: string): MessageV2.Assistant =>
      ({
        id: MessageID.zod.parse(id),
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: 0 },
        parentID: userID,
        modelID: "test",
        providerID: "test",
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }) as unknown as MessageV2.Assistant
    const input: MessageV2.WithParts[] = [
      {
        info: { ...userInfo(), id: userID },
        parts: [
          { ...basePart("u-bound"), messageID: userID, type: "text", text: "read the screenshots" },
        ] as unknown as MessageV2.Part[],
      },
      ...[1, 2].map((turn) => {
        const id = MessageID.zod.parse(`msg_bound_a${turn}`)
        return {
          info: assistant(`msg_bound_a${turn}`),
          parts: [
            {
              ...basePart(`t-bound-${turn}`),
              messageID: id,
              type: "tool",
              callID: `call-bound-${turn}`,
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: `/tmp/screenshot-${turn}.png` },
                output: "Image read successfully",
                title: "Read",
                metadata: {},
                time: { start: 0, end: 1 },
                attachments: [
                  {
                    ...basePart(`f-bound-${turn}`),
                    messageID: id,
                    type: "file",
                    mime: "image/png",
                    filename: `screenshot-${turn}.png`,
                    url: `data:image/png;base64,${"a".repeat(13 * 1024 * 1024)}`,
                  },
                ],
              },
            },
          ] as unknown as MessageV2.Part[],
        }
      }),
    ]

    const synthetic = (await MessageV2.toModelMessages(input, compatible)).filter(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content[0]?.type === "text" &&
        message.content[0].text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
    )
    expect(synthetic.map((message) => (message.content as unknown[]).slice(1))).toMatchObject([
      [{ type: "text", text: expect.stringContaining("image was removed") }],
      [{ type: "file", filename: "screenshot-2.png" }],
    ])
  })
})
