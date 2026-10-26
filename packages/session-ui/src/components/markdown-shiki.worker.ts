/// <reference lib="webworker" />

import { ShikiStreamTokenizer } from "@shikijs/stream"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked-theme"
import {
  bundledLanguages,
  createHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledLanguage,
  type ThemedToken,
} from "shiki"
import type { MarkdownToken, MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol"
import { createLatestWorkerQueue } from "./markdown-worker-queue"

type Stream = {
  language: string
  source: string
  tokenizer: ShikiStreamTokenizer
}

const streams = new Map<string, Stream>()
let highlighter: ReturnType<typeof createHighlighter> | undefined
const queue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  run: highlight,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => void streams.delete(key),
})

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  if (event.data.type === "dispose") {
    queue.dispose(event.data.key)
    return
  }
  if (event.data.type !== "highlight") {
    post({ type: "error", id: event.data.id, message: `Unsupported request: ${event.data.type}` })
    return
  }

  queue.highlight(event.data)
}

function ensureHighlighter() {
  return (highlighter ??= createHighlighter({ themes: [OpenCodeTheme], langs: [] }))
}

async function highlight(request: Extract<MarkdownWorkerRequest, { type: "highlight" }>) {
  try {
    const instance = await ensureHighlighter()
    const language = request.language in bundledLanguages ? request.language : "text"
    if (!instance.getLoadedLanguages().includes(language))
      await instance.loadLanguage(bundledLanguages[language as BundledLanguage])

    if (request.complete) {
      const result = instance.codeToTokens(request.text, { lang: language as BundledLanguage, theme: "OpenCode" })
      streams.delete(request.key)
      post({
        type: "highlight",
        id: request.id,
        key: request.key,
        language,
        reset: true,
        stable: result.tokens
          .flatMap((line, index) =>
            index === result.tokens.length - 1 ? line : [...line, { content: "\n", offset: 0 }],
          )
          .map(token),
        unstable: [],
      })
      return
    }

    const previous = streams.get(request.key)
    const reset = !previous || previous.language !== language || !request.text.startsWith(previous.source)
    const stream = reset
      ? {
          language,
          source: "",
          tokenizer: new ShikiStreamTokenizer({ highlighter: instance, lang: language, theme: "OpenCode" }),
        }
      : previous
    const result = await stream.tokenizer.enqueue(request.text.slice(stream.source.length))
    stream.source = request.text
    streams.set(request.key, stream)
    post({
      type: "highlight",
      id: request.id,
      key: request.key,
      language,
      reset,
      stable: result.stable.filter((token) => token.content.length > 0).map(token),
      unstable: result.unstable.filter((token) => token.content.length > 0).map(token),
    })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function post(response: MarkdownWorkerResponse) {
  self.postMessage(response)
}

function token(value: ThemedToken): MarkdownToken {
  return [value.content, stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value))]
}
