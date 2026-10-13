import { describe, expect, test } from "bun:test"
import { detectSlashCommand } from "../../src/acp/service"
import { promptContentToParts } from "../../src/acp/content"

describe("ACP slash command dispatch", () => {
  test("detectSlashCommand finds known command from text", () => {
    const result = detectSlashCommand([{ type: "text", text: "/help" }])
    expect(result).toBeDefined()
    expect(result!.name).toBe("help")
  })

  test("detectSlashCommand returns undefined for non-command", () => {
    expect(detectSlashCommand([{ type: "text", text: "hello world" }])).toBeUndefined()
  })

  test("promptContentToParts preserves slash command in text parts", () => {
    const parts = promptContentToParts([{ type: "text", text: "/commit add tests" }])
    expect(parts.length).toBeGreaterThan(0)
    const textParts = parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
    expect(textParts[0].text).toContain("/commit")
  })

  test("full pipeline: prompt parts -> detectSlashCommand finds command", () => {
    const parts = promptContentToParts([{ type: "text", text: "/init" }])
    const result = detectSlashCommand(parts)
    expect(result).toBeDefined()
    expect(result!.name).toBe("init")
  })

  test("full pipeline with arguments", () => {
    const parts = promptContentToParts([{ type: "text", text: "/review --diff" }])
    const result = detectSlashCommand(parts)
    expect(result).toBeDefined()
    expect(result!.name).toBe("review")
    expect(result!.args).toBe("--diff")
  })
})