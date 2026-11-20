// F5: MiniMax's Anthropic-compatible stream sometimes closes a tool_use block before its
// last input_json_delta and tags that chunk with the following thinking block's index.
// The native parser rejects that delta (packages/llm/src/protocols/anthropic-messages.ts:744-752
// appends by event.index and tool-stream.ts:151-154 errors when no tool is open); the live path
// is @ai-sdk/anthropic, so the bytes are repaired before the SDK reads them.

type Block = "tool_use" | "server_tool_use" | "text" | "thinking" | string

export function isMinimaxAnthropicURL(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return /(^|\.)minimax(i)?\.(io|com)$/.test(url.hostname) && url.pathname.includes("/anthropic/")
}

export type MinimaxRewriter = {
  push: (chunk: string) => string
  flush: () => string
}

const isTool = (type: Block | undefined) => type === "tool_use" || type === "server_tool_use"
const isReleaseStart = (event: any) =>
  event.type === "content_block_start" &&
  (event.content_block?.type === "tool_use" ||
    event.content_block?.type === "server_tool_use" ||
    event.content_block?.type === "text")

export function createMinimaxRewriter(): MinimaxRewriter {
  let partial = ""
  let lines: string[] = []
  let out = ""
  const blockTypes = new Map<number, Block>()
  let lastTool: number | undefined
  // A tool block's stop is held together with any events that follow it, until its
  // re-attributed chunk arrives or a release event proves the block is done.
  let heldStop: { index: number; event: string } | undefined
  let held: string[] = []

  const emit = (value: string) => {
    out += value
  }

  const release = () => {
    if (heldStop) emit(heldStop.event)
    emit(held.join(""))
    heldStop = undefined
    held = []
  }

  const rewrite = (event: string, dataLine: string, index: number) => {
    // Change only the index number; every other byte of the server line stays as sent.
    const body = dataLine.replace(/("index"\s*:\s*)-?\d+/, `$1${index}`)
    return body === dataLine ? event : event.replace(dataLine, body)
  }

  const onEvent = (event: string) => {
    const dataLine = event.split("\n").find((line) => line.startsWith("data:"))
    let parsed: any
    if (dataLine) {
      try {
        parsed = JSON.parse(dataLine.slice(5).trim())
      } catch {
        parsed = undefined
      }
    }

    if (!parsed) {
      // A comment or keepalive between the stop and the orphan must not release the stop.
      if (heldStop) {
        held.push(event)
        return
      }
      emit(event)
      return
    }

    const index = parsed.index
    const type = typeof index === "number" ? blockTypes.get(index) : undefined

    if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
      const orphan = lastTool !== undefined && !isTool(type)
      if (orphan && heldStop?.index === lastTool) {
        // The server sent the missing tail after closing the tool block and opening the
        // next one. Deliver the tail first, then the tool stop, then the held events.
        // Keep the stop held: the tail may arrive in more than one chunk, and any
        // thinking events that arrived after the stop stay buffered until a release event.
        emit(rewrite(event, dataLine!, lastTool!))
        return
      }
      if (heldStop) {
        held.push(event)
        return
      }
      if (orphan) {
        emit(rewrite(event, dataLine!, lastTool!))
        return
      }
      emit(event)
      return
    }

    if (heldStop) {
      if (isReleaseStart(parsed) || parsed.type === "message_delta" || parsed.type === "message_stop") {
        release()
      } else if (parsed.type === "content_block_stop" && !isTool(type)) {
        release()
      } else {
        held.push(event)
        return
      }
    }

    if (parsed.type === "content_block_start") {
      if (typeof index === "number" && parsed.content_block?.type) {
        blockTypes.set(index, parsed.content_block.type)
        if (isTool(parsed.content_block.type)) lastTool = index
      }
      emit(event)
      return
    }

    if (parsed.type === "content_block_stop") {
      if (typeof index === "number" && isTool(type) && index === lastTool) {
        heldStop = { index, event }
        return
      }
      emit(event)
      return
    }

    if (parsed.type === "message_delta" || parsed.type === "message_stop") {
      release()
      emit(event)
      return
    }

    emit(event)
  }

  const add = (raw: string) => {
    if (raw === "\n" || raw === "\r\n") {
      const event = lines.join("") + raw
      lines = []
      onEvent(event)
      return
    }
    lines.push(raw)
  }

  return {
    push(chunk) {
      partial += chunk
      let at = partial.indexOf("\n")
      while (at >= 0) {
        add(partial.slice(0, at + 1))
        partial = partial.slice(at + 1)
        at = partial.indexOf("\n")
      }
      const result = out
      out = ""
      return result
    },
    flush() {
      if (partial !== "") {
        lines.push(partial)
        partial = ""
      }
      if (lines.length) {
        const event = lines.join("")
        lines = []
        onEvent(event)
      }
      release()
      const result = out
      out = ""
      return result
    },
  }
}

export function refloatMinimaxSSE(response: Response): Response {
  if (!response.body) return response
  const rewriter = createMinimaxRewriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        const tail = rewriter.flush()
        if (tail) controller.enqueue(encoder.encode(tail))
        controller.close()
        return
      }
      const text = rewriter.push(decoder.decode(value, { stream: true }))
      if (text) controller.enqueue(encoder.encode(text))
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export function applyMinimaxSSE(input: RequestInfo | URL, response: Response): Response {
  if (!isMinimaxAnthropicURL(input)) return response
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response
  return refloatMinimaxSSE(response)
}
