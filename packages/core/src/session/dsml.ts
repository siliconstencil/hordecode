import { Schema } from "effect"

// DeepSeek V3.2 / V4 tool calls written as text. A model that does not return structured tool calls
// can emit them as DSML markup. Shape with ASCII bars (the real marker uses the full-width bar U+FF5C):
//
//   <|DSML|function_calls>
//   <|DSML|invoke name="bash">
//   <|DSML|parameter name="command" string="true">ls</|DSML|parameter>
//   <|DSML|parameter name="timeout" string="false">30</|DSML|parameter>
//   </|DSML|invoke>
//   </|DSML|function_calls>
//
// string="true" carries raw text, string="false" a JSON value. Accepted variants, observed in DeepSeek
// output: one or two bars, optional whitespace after the closing bars, and the wrapper tag word
// `calls` as well as `function_calls`. Sources: the vLLM deepseek_v32 tool parser docs, sglang
// issue 14695 and opencode issue 14050 (raw DSML tags shown instead of tools running).

const BAR = "[\\u{FF5C}|]{1,2}"
const OPEN = new RegExp(`<${BAR}DSML${BAR}\\s*(?:function_calls|calls)>`, "u")
const CLOSE = new RegExp(`</${BAR}DSML${BAR}\\s*(?:function_calls|calls)>`, "u")
const INVOKE = new RegExp(
  `<${BAR}DSML${BAR}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}\\s*invoke>`,
  "gu",
)
const PARAMETER = new RegExp(
  `<${BAR}DSML${BAR}\\s*parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}\\s*parameter>`,
  "gu",
)

export type DsmlCall = { name: string; arguments: Record<string, unknown> }

export type DsmlParse = {
  calls: DsmlCall[]
  /** The function_calls block was closed. */
  complete: boolean
  /** Nothing but whitespace follows the closed block: the model ended its turn with the calls. */
  trailing: boolean
}

export type DsmlHeal = {
  /** Every call of every healed envelope, in document order. */
  calls: DsmlCall[]
  /** The text with the healed envelopes removed. */
  text: string
}

// The healing grammar. Ported from oh-my-pi packages/ai/src/dialect/deepseek.ts:35-42,651-737,897
// (MIT, Copyright (c) 2025 Mario Zechner, 2025-2026 Can Boluk, 2026 Stencil Labs, Inc.): the same
// DSML envelope, the same `string="false"` JSON coercion, and the reference wrapper word
// `tool_calls` next to the observed `calls` and `function_calls`. The reference scanner is
// incremental and heals while the stream runs; here the envelope is parsed as a whole, so a
// half-written envelope is never healed.
const HEAL_TAG_OPEN = `<${BAR}\\s*DSML\\s*${BAR}`
const HEAL_TAG_CLOSE = `</${BAR}\\s*DSML\\s*${BAR}`
const HEAL_OPEN = new RegExp(`${HEAL_TAG_OPEN}\\s*(?:function_calls|tool_calls|calls)>`, "gu")
const HEAL_CLOSE = new RegExp(`${HEAL_TAG_CLOSE}\\s*(?:function_calls|tool_calls|calls)>`, "gu")
const HEAL_INVOKE_OPEN = new RegExp(`${HEAL_TAG_OPEN}\\s*invoke\\s+name="([^"]+)"\\s*>`, "uy")
const HEAL_INVOKE_CLOSE = new RegExp(`${HEAL_TAG_CLOSE}\\s*invoke\\s*>`, "uy")
const HEAL_PARAMETER_OPEN = new RegExp(
  `${HEAL_TAG_OPEN}\\s*parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>`,
  "uy",
)
const HEAL_PARAMETER_CLOSE = new RegExp(`${HEAL_TAG_CLOSE}\\s*parameter\\s*>`, "gu")

/** True when the text opens a DSML function_calls block. A bare invoke without the wrapper is not conformant output. */
export function hasDsmlToolCall(text: string): boolean {
  return OPEN.test(text)
}

/** Parses the first DSML function_calls block in `text`. Pure; text without a block yields no calls. */
export function parseDsmlToolCalls(text: string): DsmlParse {
  const open = OPEN.exec(text)
  if (!open) return { calls: [], complete: false, trailing: false }
  const rest = text.slice(open.index + open[0].length)
  const close = CLOSE.exec(rest)
  const body = close ? rest.slice(0, close.index) : rest
  const calls = [...body.matchAll(INVOKE)].map((invoke) => ({
    name: invoke[1],
    arguments: Object.fromEntries([...invoke[2].matchAll(PARAMETER)].map((p) => [p[1], value(p[2], p[3])])),
  }))
  const trailing = close ? rest.slice(close.index + close[0].length).trim() === "" : false
  return { calls, complete: close !== null, trailing }
}

/**
 * Parses every complete DSML envelope in `text` and returns the calls plus the text without the
 * markup. Returns undefined when the text holds no envelope, when an envelope is not closed, or
 * when any part of it is malformed: a partial envelope stays text so the retry and salvage paths
 * can still handle it.
 */
export function healDsmlToolCalls(text: string): DsmlHeal | undefined {
  const envelopes = findEnvelopes(text)
  if (!envelopes || envelopes.length === 0) return undefined
  const calls: DsmlCall[] = []
  for (const envelope of envelopes) {
    const parsed = parseEnvelope(text.slice(envelope.bodyStart, envelope.bodyEnd))
    if (!parsed) return undefined
    calls.push(...parsed)
  }
  if (calls.length === 0) return undefined
  return { calls, text: stripEnvelopes(text, envelopes) }
}

type Envelope = { start: number; end: number; bodyStart: number; bodyEnd: number }

function findEnvelopes(text: string): Envelope[] | undefined {
  const found: Envelope[] = []
  let cursor = 0
  while (cursor < text.length) {
    HEAL_OPEN.lastIndex = cursor
    const open = HEAL_OPEN.exec(text)
    if (!open) break
    const bodyStart = open.index + open[0].length
    HEAL_CLOSE.lastIndex = bodyStart
    const close = HEAL_CLOSE.exec(text)
    if (!close) return undefined
    found.push({ start: open.index, end: close.index + close[0].length, bodyStart, bodyEnd: close.index })
    cursor = close.index + close[0].length
  }
  return found
}

function parseEnvelope(body: string): DsmlCall[] | undefined {
  const calls: DsmlCall[] = []
  let cursor = 0
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor++
    if (cursor >= body.length) break
    HEAL_INVOKE_OPEN.lastIndex = cursor
    const invoke = HEAL_INVOKE_OPEN.exec(body)
    if (!invoke) return undefined
    cursor += invoke[0].length
    const args: Record<string, unknown> = {}
    while (true) {
      while (cursor < body.length && /\s/.test(body[cursor]!)) cursor++
      HEAL_INVOKE_CLOSE.lastIndex = cursor
      const invokeClose = HEAL_INVOKE_CLOSE.exec(body)
      if (invokeClose) {
        cursor += invokeClose[0].length
        break
      }
      HEAL_PARAMETER_OPEN.lastIndex = cursor
      const parameter = HEAL_PARAMETER_OPEN.exec(body)
      if (!parameter) return undefined
      cursor += parameter[0].length
      HEAL_PARAMETER_CLOSE.lastIndex = cursor
      const close = HEAL_PARAMETER_CLOSE.exec(body)
      if (!close) return undefined
      args[parameter[1]!] = value(parameter[2], body.slice(cursor, close.index))
      cursor = close.index + close[0].length
    }
    calls.push({ name: invoke[1]!, arguments: args })
  }
  return calls
}

function stripEnvelopes(text: string, envelopes: Envelope[]): string {
  let out = ""
  let cursor = 0
  for (const envelope of envelopes) {
    out += text.slice(cursor, envelope.start)
    cursor = envelope.end
  }
  return (out + text.slice(cursor)).trim()
}

function value(string: string | undefined, raw: string): unknown {
  if (string !== "false") return raw
  const parsed = safeJson(raw.trim())
  return parsed.ok ? parsed.value : raw
}

function safeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const result = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  return result._tag === "Some" ? { ok: true, value: result.value } : { ok: false }
}

export * as Dsml from "./dsml"
