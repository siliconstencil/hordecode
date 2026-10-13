// @ts-nocheck
import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"

const PROMPT_INDEX = path.resolve(import.meta.dir, "../../../src/component/prompt/index.tsx")

describe("welcome-screen hint bar nowrap", () => {
  test("LSP and MCP text nodes carry wrapMode=none and flexShrink=0 (matching sibling text nodes)", async () => {
    const source = await fs.readFile(PROMPT_INDEX, "utf-8")

    // Match each `<text ...> ... LSP </text>` and `<text ...> ... MCP </text>` block,
    // allowing multi-line content (the body is on its own line between the tags).
    const lspMatch = source.match(/<text\b([^>]*?)>\s*\{lspCount\(\)\} LSP\s*<\/text>/)
    const mcpMatch = source.match(/<text\b([^>]*?)>\s*\{mcpCount\(\)\} MCP\s*<\/text>/)
    expect(lspMatch).not.toBeNull()
    expect(mcpMatch).not.toBeNull()

    const lspProps = lspMatch![1]!
    const mcpProps = mcpMatch![1]!

    // The defect: both nodes were missing wrapMode="none" and flexShrink={0},
    // so when the hint bar got crowded the LSP/MCP tokens wrapped to a second
    // row. Sibling text nodes (e.g. the editor file label around line 1706,
    // and the usage context/cost node around line 1717) already carry these
    // two props and do not wrap -- this test pins both nodes to the same shape.
    expect(lspProps).toMatch(/wrapMode\s*=\s*"none"/)
    expect(lspProps).toMatch(/flexShrink\s*=\s*\{0\}/)
    expect(mcpProps).toMatch(/wrapMode\s*=\s*"none"/)
    expect(mcpProps).toMatch(/flexShrink\s*=\s*\{0\}/)
  })

  test("sibling file-label text node still carries wrapMode=none + flexShrink=0 (regression guard)", async () => {
    // Pin the reference pattern itself -- if the sibling nodes ever lose these
    // props, the "match the sibling" rationale breaks and the bug
    // would come back under a different guise. Sibling = editorContextLabelState
    // file-label <text> at roughly line 1706.
    const source = await fs.readFile(PROMPT_INDEX, "utf-8")
    const siblingMatch = source.match(/<text\b([^>]*?)>\s*\{file\(\)\}\s*<\/text>/)
    expect(siblingMatch).not.toBeNull()
    const props = siblingMatch![1]!
    expect(props).toMatch(/wrapMode\s*=\s*"none"/)
    expect(props).toMatch(/flexShrink\s*=\s*\{0\}/)
  })
})
