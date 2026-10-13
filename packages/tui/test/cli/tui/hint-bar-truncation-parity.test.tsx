import { afterEach, describe, expect, test } from "bun:test"
import { Show } from "solid-js"
import { testRender, type JSX } from "@opentui/solid"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type Status = { type: "idle" } | { type: "busy" }

// Reference implementation hint bar layout: outer row with justifyContent=space-between, no
// flexShrink / minWidth on the wrapper, no wrapMode / flexShrink on the inner
// text. Each hint segment is its own <text>. The terminal clips what does not
// fit; the layout engine never asks a <text> to shrink mid-glyph.
//
// The bug this fixes: the previous fork added flexShrink=1 minWidth=0 on the
// outer wrapper and flexShrink=0 marginLeft="auto" on the right cluster; that
// pair asked the left cluster to shrink onto the right, which produced visible
// overlaps like "@tattachefile" (no space between @ and "attach file") at narrow
// widths. The reference implementation's layout never produces those artefacts.
function HintBar(props: { width: number; status: Status; input: string; lsp: number; mcp: number }) {
  const showHints = () => props.input === ""

  const segments = (): JSX.Element[] => [
    <text>·</text>,
    <text>@ attach file</text>,
    <text>$ subagent</text>,
    <text>/ commands</text>,
  ]

  return (
    <box width={props.width} flexDirection="row" justifyContent="space-between" gap={2}>
      <box gap={2} flexDirection="row">
        <Show when={showHints()}>
          <box gap={2} flexDirection="row">
            <text>·</text>
            <text>tab switch mode</text>
            <text>ctrl+p settings</text>
          </box>
        </Show>
      </box>
      <box gap={2} flexDirection="row">
        <Show
          when={props.status.type === "idle" && props.input === ""}
          fallback={<Show when={props.status.type !== "idle"}>{segments()}</Show>}
        >
          {segments()}
        </Show>
        <text>{props.lsp} LSP</text>
        <text>{props.mcp} MCP</text>
      </box>
    </box>
  )
}

async function renderHintBar(opts: {
  width: number
  status: Status
  input: string
  lsp?: number
  mcp?: number
  height?: number
}) {
  testSetup = await testRender(
    () => (
      <HintBar
        width={opts.width}
        status={opts.status}
        input={opts.input}
        lsp={opts.lsp ?? 0}
        mcp={opts.mcp ?? 0}
      />
    ),
    { width: opts.width, height: opts.height ?? 6 },
  )
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0)
    .join("\n")
}

describe("TUI hint bar truncation parity", () => {
  test("60 cols idle + empty input: every hint segment's tokens appear in the rendered frame", async () => {
    const frame = await renderHintBar({ width: 60, status: { type: "idle" }, input: "" })
    expect(frame).toContain("tab")
    expect(frame).toContain("switch")
    expect(frame).toContain("mode")
    expect(frame).toContain("ctrl+p")
    expect(frame).toContain("settings")
    expect(frame).toContain("@")
    expect(frame).toContain("attach")
    expect(frame).toContain("file")
    expect(frame).toContain("$")
    // "subagent" appears either intact ("subagent") or wrapped ("subagen" + "t").
    expect(frame).toContain("subagen")
    expect(frame).toContain("/")
    // "commands" appears either intact ("commands") or wrapped ("command" + "s").
    expect(frame).toContain("command")
    expect(frame).toContain("LSP")
    expect(frame).toContain("MCP")
  })

  test("60 cols idle + empty input: no seg-overlap artifact strings", async () => {
    const frame = await renderHintBar({ width: 60, status: { type: "idle" }, input: "" })
    // The old buggy fork produced strings like "@tattache" (no space between
    // @ and "attach file") when the left flexShrink collapsed onto the
    // marginLeft:auto right cluster. The reference implementation's layout never produces
    // these concatenated literals -- each hint segment is a separate <text>
    // that wraps internally rather than overwriting its neighbour.
    expect(frame).not.toContain("@tattache")
    expect(frame).not.toContain("attachfile")
    expect(frame).not.toContain("subagentfile")
    expect(frame).not.toContain("subagentcommands")
    expect(frame).not.toContain("commandsLSP")
  })

  test("60 cols idle + empty input: 'switch mode' stays as two intact tokens, not 'switch m...'", async () => {
    const frame = await renderHintBar({ width: 60, status: { type: "idle" }, input: "" })
    expect(frame).toContain("switch")
    expect(frame).toContain("mode")
    expect(frame).not.toContain("switch m\n")
    expect(frame).not.toMatch(/switch m[a-z]?\s/)
  })

  test("60 cols idle + empty input: @ and $ and / markers appear as standalone tokens, not glued to neighbour text", async () => {
    const frame = await renderHintBar({ width: 60, status: { type: "idle" }, input: "" })
    // Each marker (@, $, /) must be a standalone token in the frame, separated
    // from its following word by whitespace OR by row wrap. The buggy layout
    // produced "@attach" or "@tattache" with no separator at all.
    expect(frame).toMatch(/@\s/)
    expect(frame).toMatch(/\$\s/)
    expect(frame).toMatch(/\/\s/)
    expect(frame).not.toMatch(/@[a-z]/)
    expect(frame).not.toMatch(/\$[a-z]/)
  })

  test("110 cols busy + non-empty input: right-side hints render without overlap artifacts", async () => {
    const frame = await renderHintBar({ width: 110, status: { type: "busy" }, input: "hi" })
    expect(frame).toContain("attach")
    expect(frame).toContain("file")
    expect(frame).toContain("subagen")
    expect(frame).toContain("command")
    expect(frame).not.toContain("tattache")
    expect(frame).not.toContain("attachfile")
    expect(frame).not.toContain("subagentcommands")
  })

  test("160 cols idle + empty input: full hint bar fits cleanly on one row without overlap", async () => {
    const frame = await renderHintBar({ width: 160, status: { type: "idle" }, input: "" })
    expect(frame).toContain("switch mode")
    expect(frame).toContain("ctrl+p settings")
    expect(frame).toContain("@ attach file")
    expect(frame).toContain("$ subagent")
    expect(frame).toContain("/ commands")
    expect(frame).toContain("LSP")
    expect(frame).toContain("MCP")
  })
})
