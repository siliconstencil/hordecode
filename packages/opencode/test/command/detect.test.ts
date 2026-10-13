import { describe, expect, test } from "bun:test"
import { detectSlashCommand } from "../../src/acp/service"

describe("detectSlashCommand", () => {
  test("simple slash", () => {
    expect(detectSlashCommand([{ type: "text", text: "/help" }])).toEqual({ name: "help", args: "" })
  })

  test("with args", () => {
    expect(detectSlashCommand([{ type: "text", text: "/commit feat: add foo" }])).toEqual({
      name: "commit",
      args: "feat: add foo",
    })
  })

  test("non-slash", () => {
    expect(detectSlashCommand([{ type: "text", text: "just a message" }])).toBeUndefined()
  })

  test("empty", () => {
    expect(detectSlashCommand([{ type: "text", text: "" }])).toBeUndefined()
  })

  test("slash only", () => {
    expect(detectSlashCommand([{ type: "text", text: "/" }])).toBeUndefined()
  })

  test("multiple text parts concatenated", () => {
    expect(detectSlashCommand([{ type: "text", text: "/commit" }, { type: "text", text: " add tests" }])).toEqual({
      name: "commit",
      args: "add tests",
    })
  })

  test("leading/trailing whitespace", () => {
    expect(detectSlashCommand([{ type: "text", text: "  /help  " }])).toEqual({ name: "help", args: "" })
  })

  test("mixed text+image parts", () => {
    expect(
      detectSlashCommand([
        { type: "text", text: "/help" },
        { type: "file", url: "data:image/png;base64,AAAA", filename: "img.png", mime: "image/png" },
      ]),
    ).toEqual({ name: "help", args: "" })
  })

  test("complex args with spaces", () => {
    expect(detectSlashCommand([{ type: "text", text: "/review   main   branch" }])).toEqual({
      name: "review",
      args: "main branch",
    })
  })
})
