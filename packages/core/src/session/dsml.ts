import { Schema } from "effect"

// DeepSeek V3.2 / V4 tool calls written as text. A model that does not return structured tool calls
// can emit them as DSML markup:
//
//   <｜DSML｜function_calls>
//   <｜DSML｜invoke name="bash">
//   <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
//   <｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜function_calls>
//
// string="true" carries raw text, string="false" a JSON value. The marker is the full-width bar
// U+FF5C; an ASCII bar is accepted too. Sources: the vLLM deepseek_v32 tool parser docs, sglang
// issue 14695 and opencode issue 14050 (raw DSML tags shown instead of tools running).

const BAR = "[\\u{FF5C}|]"
const OPEN = new RegExp(`<${BAR}DSML${BAR}function_calls>`, "u")
const CLOSE = new RegExp(`</${BAR}DSML${BAR}function_calls>`, "u")
const INVOKE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}invoke>`, "gu")
const PARAMETER = new RegExp(
  `<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`,
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
