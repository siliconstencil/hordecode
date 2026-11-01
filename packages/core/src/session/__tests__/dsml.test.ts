import { describe, expect, test } from "bun:test"
import { hasDsmlToolCall, parseDsmlToolCalls } from "../dsml"

const M = "\uff5cDSML\uff5c"
const block = (inner: string) => `<${M}function_calls>\n${inner}\n</${M}function_calls>`
const invoke = (name: string, params: string) => `<${M}invoke name="${name}">\n${params}\n</${M}invoke>`
const param = (name: string, string: "true" | "false", value: string) =>
  `<${M}parameter name="${name}" string="${string}">${value}</${M}parameter>`

describe("DSML tool call parser", () => {
  test("parses a documented call with string and JSON parameters", () => {
    const text = block(invoke("bash", param("command", "true", "ls -la") + "\n" + param("timeout", "false", "30")))
    expect(parseDsmlToolCalls(text)).toEqual({
      calls: [{ name: "bash", arguments: { command: "ls -la", timeout: 30 } }],
      complete: true,
      trailing: true,
    })
  })

  test("parses several invokes in order", () => {
    const text = block(invoke("read", param("filePath", "true", "/a")) + "\n" + invoke("read", param("filePath", "true", "/b")))
    expect(parseDsmlToolCalls(text).calls.map((c) => c.arguments.filePath)).toEqual(["/a", "/b"])
  })

  test("string=true keeps JSON-looking text raw, string=false decodes objects and arrays", () => {
    const text = block(
      invoke("x", param("raw", "true", '{"a":1}') + param("obj", "false", '{"a":1}') + param("list", "false", "[1,2]")),
    )
    expect(parseDsmlToolCalls(text).calls[0]?.arguments).toEqual({ raw: '{"a":1}', obj: { a: 1 }, list: [1, 2] })
  })

  test("string=false with invalid JSON falls back to the raw text", () => {
    expect(parseDsmlToolCalls(block(invoke("x", param("v", "false", "not json")))).calls[0]?.arguments).toEqual({
      v: "not json",
    })
  })

  test("multi-line parameter values and an omitted string attribute stay raw", () => {
    const text = block(invoke("write", `<${M}parameter name="content">a\nb</${M}parameter>`))
    expect(parseDsmlToolCalls(text).calls[0]?.arguments).toEqual({ content: "a\nb" })
  })

  test("accepts the ASCII bar form", () => {
    const text = "<|DSML|function_calls><|DSML|invoke name=\"x\"><|DSML|parameter name=\"a\" string=\"true\">1</|DSML|parameter></|DSML|invoke></|DSML|function_calls>"
    expect(parseDsmlToolCalls(text).calls).toEqual([{ name: "x", arguments: { a: "1" } }])
  })

  test("an unclosed block is reported incomplete", () => {
    const text = `<${M}function_calls>\n${invoke("x", param("a", "true", "1"))}`
    const parsed = parseDsmlToolCalls(text)
    expect(parsed.complete).toBe(false)
    expect(parsed.trailing).toBe(false)
    expect(parsed.calls).toHaveLength(1)
  })

  test("text after the block is not trailing", () => {
    const parsed = parseDsmlToolCalls(block(invoke("x", "")) + "\nand then I explain")
    expect(parsed.complete).toBe(true)
    expect(parsed.trailing).toBe(false)
  })

  test("a bare invoke without the wrapper is not a tool call", () => {
    const text = invoke("x", param("a", "true", "1"))
    expect(hasDsmlToolCall(text)).toBe(false)
    expect(parseDsmlToolCalls(text)).toEqual({ calls: [], complete: false, trailing: false })
  })

  test("plain text and the legacy invoke markup are not DSML", () => {
    expect(hasDsmlToolCall("hello")).toBe(false)
    expect(hasDsmlToolCall('<invoke name="bash"></invoke>')).toBe(false)
    expect(hasDsmlToolCall(block(""))).toBe(true)
  })
})
