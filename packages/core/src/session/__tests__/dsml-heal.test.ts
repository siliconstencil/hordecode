import { describe, expect, test } from "bun:test"
import { healDsmlToolCalls } from "../dsml"

const M = "\uff5cDSML\uff5c"
const block = (inner: string, word = "calls") => `<${M}${word}>\n${inner}\n</${M}${word}>`
const invoke = (name: string, params: string) => `<${M}invoke name="${name}">\n${params}\n</${M}invoke>`
const param = (name: string, string: "true" | "false" | undefined, value: string) =>
  `<${M}parameter name="${name}"${string === undefined ? "" : ` string="${string}"`}>${value}</${M}parameter>`

describe("DSML envelope healing", () => {
  test("heals the bash call of the field report and keeps the argument types", () => {
    const text = [
      "<|DSML|calls>",
      '<|DSML|invoke name="bash">',
      '<|DSML|parameter name="command" string="true">ls -la</|DSML|parameter>',
      '<|DSML|parameter name="timeout" string="false">120</|DSML|parameter>',
      '<|DSML|parameter name="workdir" string="true">/home/hank</|DSML|parameter>',
      "</|DSML|invoke>",
      "</|DSML|calls>",
    ].join("\n")
    expect(healDsmlToolCalls(text)).toEqual({
      calls: [{ name: "bash", arguments: { command: "ls -la", timeout: 120, workdir: "/home/hank" } }],
      text: "",
    })
  })

  test("keeps the prose around the envelope and removes the markup", () => {
    const text = `Let me check.\n${block(invoke("read", param("filePath", "true", "/a")))}\nthen I report.`
    const healed = healDsmlToolCalls(text)
    expect(healed?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
    expect(healed?.text).toBe("Let me check.\n\nthen I report.")
  })

  test("heals every envelope of the text in document order", () => {
    const text = `${block(invoke("read", param("filePath", "true", "/a")))}\n${block(invoke("read", param("filePath", "true", "/b")))}`
    expect(healDsmlToolCalls(text)?.calls.map((call) => call.arguments.filePath)).toEqual(["/a", "/b"])
  })

  test("the reference wrapper word tool_calls is healed too", () => {
    const text = block(invoke("read", param("filePath", "true", "/a")), "tool_calls")
    expect(healDsmlToolCalls(text)?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
  })

  test("the real DeepSeek form with two full-width bars is healed", () => {
    const B = "\uFF5C\uFF5C"
    const D = `${B}DSML${B}`
    const text = [
      `<${D} calls>`,
      `<${D} invoke name="bash">`,
      `<${D} parameter name="command" string="true">pwd</${D} parameter>`,
      `<${D} parameter name="timeout" string="false">30</${D} parameter>`,
      `</${D} invoke>`,
      `</${D} calls>`,
    ].join("\n")
    expect(healDsmlToolCalls(text)?.calls).toEqual([
      { name: "bash", arguments: { command: "pwd", timeout: 30 } },
    ])
  })

  test("the double ASCII bar spelling is healed", () => {
    const text = [
      "<||DSML||calls>",
      '<||DSML||invoke name="read">',
      '<||DSML||parameter name="filePath" string="true">/a</||DSML||parameter>',
      "</||DSML||invoke>",
      "</||DSML||calls>",
    ].join("\n")
    expect(healDsmlToolCalls(text)?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
  })

  test("the spaced spelling is healed", () => {
    const text = [
      "<| DSML | calls>",
      '<| DSML | invoke name="read">',
      '<| DSML | parameter name="filePath" string="true">/a</| DSML | parameter>',
      "</| DSML | invoke>",
      "</| DSML | calls>",
    ].join("\n")
    expect(healDsmlToolCalls(text)?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
  })

  test("a block without newlines is healed", () => {
    const text =
      '<|DSML|calls><|DSML|invoke name="read"><|DSML|parameter name="filePath" string="true">/a</|DSML|parameter></|DSML|invoke></|DSML|calls>'
    expect(healDsmlToolCalls(text)?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
  })

  test("the V3.2 function_calls wrapper is healed too", () => {
    const text = block(invoke("read", param("filePath", "true", "/a")), "function_calls")
    expect(healDsmlToolCalls(text)?.calls).toEqual([{ name: "read", arguments: { filePath: "/a" } }])
  })

  test("an invoke without the outer wrapper is not healed", () => {
    const text = [
      '<|DSML|invoke name="read">',
      '<|DSML|parameter name="filePath" string="true">/a</|DSML|parameter>',
      "</|DSML|invoke>",
    ].join("\n")
    expect(healDsmlToolCalls(text)).toBeUndefined()
  })

  test("an envelope that is not closed is not healed", () => {
    const text = `<${M}calls>\n${invoke("read", param("filePath", "true", "/a"))}`
    expect(healDsmlToolCalls(text)).toBeUndefined()
  })

  test("an envelope with an unclosed invoke is not healed", () => {
    const text = `<${M}calls>\n<${M}invoke name="read">\n${param("filePath", "true", "/a")}\n</${M}calls>`
    expect(healDsmlToolCalls(text)).toBeUndefined()
  })

  test("an envelope with an unclosed parameter is not healed", () => {
    const text = `<${M}calls>\n<${M}invoke name="read">\n<${M}parameter name="filePath" string="true">/a\n</${M}invoke>\n</${M}calls>`
    expect(healDsmlToolCalls(text)).toBeUndefined()
  })

  test("prose inside the envelope is malformed and is not healed", () => {
    const text = `<${M}calls>\nplease run this\n${invoke("read", param("filePath", "true", "/a"))}\n</${M}calls>`
    expect(healDsmlToolCalls(text)).toBeUndefined()
  })

  test("text without an envelope is not healed", () => {
    expect(healDsmlToolCalls("hello")).toBeUndefined()
    expect(healDsmlToolCalls(invoke("read", param("filePath", "true", "/a")))).toBeUndefined()
  })

  test("an envelope without a call heals to nothing", () => {
    expect(healDsmlToolCalls(`<${M}calls>\n</${M}calls>`)).toBeUndefined()
  })

  test("an omitted string attribute keeps the raw text", () => {
    const text = block(invoke("write", param("content", undefined, "a\nb")))
    expect(healDsmlToolCalls(text)?.calls[0]?.arguments).toEqual({ content: "a\nb" })
  })

  test("string=false with invalid JSON falls back to the raw text", () => {
    const text = block(invoke("x", param("v", "false", "not json")))
    expect(healDsmlToolCalls(text)?.calls[0]?.arguments).toEqual({ v: "not json" })
  })
})
