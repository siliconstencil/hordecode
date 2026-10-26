import { expect, mock, test } from "bun:test"

const parsed: string[] = []
mock.module("./markdown-worker", () => ({
  parseMarkdown: async (text: string) => {
    parsed.push(text)
    return `<p>${text}</p>`
  },
}))

const { getCachedMarkdown, preloadMarkdown } = await import("./markdown-cache")

test("preloads completed markdown into the render cache", async () => {
  const key = `markdown-preload-${crypto.randomUUID()}`

  await preloadMarkdown("prepared response", key)
  await preloadMarkdown("prepared response", key)

  expect(parsed).toEqual(["prepared response"])
  expect(getCachedMarkdown(`${key}:0:full`)?.raw).toBe("prepared response")
})
