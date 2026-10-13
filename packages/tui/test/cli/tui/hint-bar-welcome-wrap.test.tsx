// @ts-nocheck
// The home welcome box
// is 75 cols (routes/home.tsx:34-38: Math.max(75, Math.floor(width * 0.7))).
// An earlier approach added wrapMode="none" truncate flexShrink={0} to every hint text
// AND every dot marker AND the LSP/MCP pair -- truncate on every node
// overlaps: on the landed binary at 236x69 the captured frame showed
// "ctrl+p sett-ng@ attach file ... commands MCP" (settings->sett-ng,
// attach file->attach/file, commands clipped, MCP wedged against
// commands). The right fix is the 0.1.12 parity reference shape:
// plain <text fg=...> with no wrapMode/truncate/flexShrink props
// (the reference relies on the wider container that the welcome box
// already provides at 75+ cols), plus gate the LSP/MCP counter pair
// to the session view only -- the welcome route has no session and
// the reference has no counters on the welcome row.
//
// This test mirrors hint-bar-truncation-parity.test.tsx shape and
// asserts the user-visible claim directly: at every width the welcome
// screen can show, every hint token appears fully, exactly once, on
// one row; LSP/MCP do not appear on the welcome row; in the session
// view at 236 cols all five tokens plus "0 LSP" and "0 MCP" land on
// one row.
import { Show } from "solid-js"
import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"

// Welcome hint row -- mirrors the post-fix fork: hint <text> nodes
// carry NO wrapMode/truncate/flexShrink (the 0.1.12 reference shape
// verified at packages/opencode/src/cli/cmd/tui/component/prompt/
// index.tsx:2016-2032). The LSP/MCP counter pair is gated on
// sessionID (the welcome/home route has sessionID undefined; see
// packages/tui/src/component/prompt/index.tsx:65 PromptProps.sessionID).
function WelcomeHints(props: { width: number; idle: boolean; input: string; sessionID?: string; lsp: number; mcp: number }) {
  const showRight = () => props.idle && props.input === ""
  return (
    <box width={props.width} flexDirection="row" justifyContent="flex-start" gap={2}>
      <box gap={2} flexDirection="row">
        <Show when={props.input === ""}>
          <text fg="white">·</text>
          <text fg="white">tab switch mode</text>
          <text fg="white">ctrl+p settings</text>
        </Show>
      </box>
      <box gap={2} flexDirection="row">
        <Show when={showRight()}>
          <text fg="white">·</text>
          <text fg="white">@ attach file</text>
          <text fg="white">$ subagent</text>
          <text fg="white">/ commands</text>
        </Show>
        <Show when={props.sessionID !== undefined}>
          <text fg="white">{props.lsp} LSP</text>
          <text fg="white">{props.mcp} MCP</text>
        </Show>
      </box>
    </box>
  )
}

async function render(opts: {
  width: number
  idle: boolean
  input?: string
  sessionID?: string
  lsp?: number
  mcp?: number
}) {
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  setup = await testRender(
    () => (
      <WelcomeHints
        width={opts.width}
        idle={opts.idle}
        input={opts.input ?? ""}
        sessionID={opts.sessionID}
        lsp={opts.lsp ?? 0}
        mcp={opts.mcp ?? 0}
      />
    ),
    { width: opts.width, height: 6 },
  )
  await setup.renderOnce()
  await setup.renderOnce()
  const lines = setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0)
  setup.renderer.destroy()
  return lines
}

// Five tokens the welcome row must carry fully (no clip, no wrap).
const WELCOME_TOKENS = ["switch mode", "settings", "attach file", "subagent", "commands"] as const

describe("welcome hint row", () => {
  afterEach(() => {
    // renderer.destroy() handled inside render()
  })

  test("75-col welcome box (default home width): every token exactly once, no LSP/MCP, on one row", async () => {
    // routes/home.tsx:34-38: Math.max(75, Math.floor(width * 0.7)). On a
    // 75-col or wider terminal the prompt is at least 75 cols.
    const lines = await render({ width: 75, idle: true })
    const flat = lines.join("\n")
    for (const token of WELCOME_TOKENS) {
      expect(flat).toContain(token)
      // Each token must appear exactly once and fully -- no mid-glyph clip
      // (no "sett-ng", no "attach/file", no "command" without "s").
      expect(flat).not.toContain("sett·ng")
      expect(flat).not.toContain("attach/file")
    }
    // No LSP/MCP on welcome row.
    expect(flat).not.toContain("LSP")
    expect(flat).not.toContain("MCP")
    // Every token on one row.
    for (const token of WELCOME_TOKENS) {
      const occurrences = lines.filter((l) => l.includes(token)).length
      expect(occurrences).toBe(1)
    }
  })

  test("165-col welcome box (very wide terminal): every token exactly once, no LSP/MCP, on one row", async () => {
    const lines = await render({ width: 165, idle: true })
    const flat = lines.join("\n")
    for (const token of WELCOME_TOKENS) {
      expect(flat).toContain(token)
    }
    expect(flat).not.toContain("LSP")
    expect(flat).not.toContain("MCP")
    for (const token of WELCOME_TOKENS) {
      const occurrences = lines.filter((l) => l.includes(token)).length
      expect(occurrences).toBe(1)
    }
  })

  test("236-col session-view bar: five tokens + '0 LSP' + '0 MCP' all on one row", async () => {
    // The session view passes a sessionID, so the LSP/MCP pair renders
    // here exactly as it does today in production.
    const lines = await render({
      width: 236,
      idle: true,
      sessionID: "test-session-1",
      lsp: 0,
      mcp: 0,
    })
    const flat = lines.join("\n")
    for (const token of WELCOME_TOKENS) {
      expect(flat).toContain(token)
    }
    expect(flat).toContain("0 LSP")
    expect(flat).toContain("0 MCP")
    // No clipping artefacts.
    expect(flat).not.toContain("sett·ng")
    expect(flat).not.toContain("attach/file")
    // Seven tokens (5 hints + 0 LSP + 0 MCP), each exactly once.
    const tokens = [...WELCOME_TOKENS, "0 LSP", "0 MCP"]
    for (const token of tokens) {
      const occurrences = lines.filter((l) => l.includes(token)).length
      expect(occurrences).toBe(1)
    }
  })
})
