import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Regression guard.
//
// `packages/tui/src/plugin/command-shim.ts:69` (`toBindings`) flatMaps over
// the command list and requires `item.keybind` to exist before it looks up
// the configured binding in `TuiKeybind.CommandMap`. Commands whose
// definitions lack `keybind:` are therefore unreachable from the keyboard,
// even when the matching entry exists in `keybind.ts` AND `CommandMap`.
//
// This regression has been seen twice on fork/main:
//   - session.child.next / session.child.previous /
//     session.child.first (right/left arrow child-cycle was dead; config
//     entries existed but command objects lacked `keybind:` fields).
//   - (same root cause): 27 other
//     Session-category commands shared the same gap.
//
// This test reads the route file and asserts the `keybind:` field is
// present on every fork Session-category command that has a reference
// implementation counterpart with a `keybind:` field. If a future PR drops a `keybind:`
// field or removes a command definition, this test fails before the
// regression ships. Source-text inspection is the only reliable check --
// `command-shim.ts:69` is the single binding path but it cannot be
// exercised without a live TUI + dialog + keymap stack.

const ROUTE_PATH = join(import.meta.dir, "..", "..", "src", "routes", "session", "index.tsx")

// value -> expected keybind string (the literal the reference implementation uses, after
// the rename map). Verified against packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
// line-by-line. Any future divergence must be re-verified against that
// reference and this map updated.
const EXPECTED: Record<string, string> = {
  "session.share": "session_share",
  "session.rename": "session_rename",
  "session.timeline": "session_timeline",
  "session.fork": "session_fork",
  "session.compact": "session_compact",
  "session.unshare": "session_unshare",
  "session.undo": "messages_undo",
  "session.redo": "messages_redo",
  "session.sidebar.toggle": "sidebar_toggle",
  "session.toggle.conceal": "messages_toggle_conceal",
  "session.toggle.thinking": "display_thinking",
  "session.toggle.actions": "tool_details",
  "session.toggle.scrollbar": "scrollbar_toggle",
  "session.page.up": "messages_page_up",
  "session.page.down": "messages_page_down",
  "session.line.up": "messages_line_up",
  "session.line.down": "messages_line_down",
  "session.half.page.up": "messages_half_page_up",
  "session.half.page.down": "messages_half_page_down",
  "session.first": "messages_first",
  "session.last": "messages_last",
  "session.messages_last_user": "messages_last_user",
  "session.message.next": "messages_next",
  "session.message.previous": "messages_previous",
  "messages.copy": "messages_copy",
  "session.export": "session_export",
  "session.child.first": "session_child_first",
  "session.parent": "session_parent",
  "session.child.next": "session_child_cycle",
  "session.child.previous": "session_child_cycle_reverse",
}

// Walk the command-list block and collect (value -> keybind) pairs.
// Naive line-by-line parse: command objects are nested 4-space-indented
// top-level entries inside `sessionCommandList = createMemo(() => [ ... ])`,
// each entry begins with `value: "..."` and may carry an adjacent
// `keybind: "..."` line (keybind follows value in the reference implementation).
function collectCommandKeybinds(source: string): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>()
  // Match the sessionCommandList block. The closing `])` is the one at the
  // SAME indentation as the opening `[` (the array literal's matching
  // close), NOT the `])` inside `createMemo(() => [` (the createMemo
  // call's close bracket, which appears first when scanning forward).
  const lines = source.split("\n")
  const startLineIdx = lines.findIndex((l) => l.includes("const sessionCommandList = createMemo(() => ["))
  if (startLineIdx === -1) throw new Error("sessionCommandList block not found")
  // Walk forward looking for `  ])` (2-space-indent close of the array
  // literal). This is robust to nested braces/brackets inside individual
  // command objects. Strip trailing `\r` because the file uses CRLF.
  let endLineIdx = -1
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "")
    if (line === "  ])") {
      endLineIdx = i
      break
    }
  }
  if (endLineIdx === -1) throw new Error("sessionCommandList end not found")
  const block = lines.slice(startLineIdx, endLineIdx + 1).join("\n")

  // Split on `value: "..."` boundaries; for each block, look for the
  // first `keybind: "..."` line within the same command object (the
  // top-level command entry). Adjacent lines only -- the reference implementation puts
  // keybind on the line right after value.
  const valueRegex = /value:\s*"([^"]+)"/g
  const keybindRegex = /keybind:\s*"([^"]+)"/
  let match: RegExpExecArray | null
  while ((match = valueRegex.exec(block)) !== null) {
    const value = match[1]
    // Look ahead up to 8 lines (the reference implementation puts keybind on the next line, but
    // defensive in case of whitespace differences).
    const tail = block.slice(match.index, match.index + 800)
    const kbMatch = tail.match(keybindRegex)
    const keybind = kbMatch ? kbMatch[1] : undefined
    result.set(value, keybind)
  }
  return result
}

describe("session route command.keybind wiring", () => {
  const source = readFileSync(ROUTE_PATH, "utf-8")
  const found = collectCommandKeybinds(source)

  it("session.child.next carries keybind: session_child_cycle (right arrow dead without it)", () => {
    expect(found.get("session.child.next")).toBe("session_child_cycle")
  })

  it("session.child.previous carries keybind: session_child_cycle_reverse (left arrow dead without it)", () => {
    expect(found.get("session.child.previous")).toBe("session_child_cycle_reverse")
  })

  it("session.child.first carries keybind: session_child_first", () => {
    expect(found.get("session.child.first")).toBe("session_child_first")
  })

  it("every Session-category command with a reference implementation counterpart carries the expected keybind value", () => {
    const missing: string[] = []
    const wrong: string[] = []
    for (const [value, expectedKeybind] of Object.entries(EXPECTED)) {
      const actual = found.get(value)
      if (actual === undefined) missing.push(value)
      else if (actual !== expectedKeybind) wrong.push(`${value}: got ${actual}, expected ${expectedKeybind}`)
    }
    expect(missing).toEqual([])
    expect(wrong).toEqual([])
  })
})
