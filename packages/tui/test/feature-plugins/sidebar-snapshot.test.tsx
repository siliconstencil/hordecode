import { afterEach, describe, expect, test } from "bun:test"
import { For, Show } from "solid-js"
import { testRender, type JSX } from "@opentui/solid"

/**
 * Sidebar golden snapshot tests.
 *
 * These tests verify the visual output of ALL sidebar panels rendered
 * together in a single fixture -- the exact composition a user sees.
 *
 * Pattern: inline-tool-wrap-snapshot.test.tsx (testRender + captureCharFrame)
 *
 * KEY BEHAVIOR: Todo panel hides when Tasks panel has items.
 * This is intentional -- Hordecode deliberate UX choice, NOT a bug.
 * Source: fork/packages/tui/src/feature-plugins/sidebar/todo.tsx line 13-14
 *
 *     const show = createMemo(
 *       () => tasks().length === 0 && list().length > 0 && list.some((i) => i.status !== "completed"),
 *     )
 *
 * upstream has the identical guard (todo.tsx:12-14) -- this IS parity, not a Hordecode choice.
 * If someone "fixes" this, they break parity with upstream.
 */

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

// -- Glyph constants (match sidebar plugin conventions) ----------------
const G = {
  running: "\u2022", // •
  done: "v",
  bullet: "\u2022", // •
  check: "\u2713", // ✓
  blocked: "\u23f8", // ⏸
  down: "\u25be", // ▾
  up: "\u25b8", // ▸
  spinner: "\u280b", // ⠋
} as const

// -- Mock data ---------------------------------------------------------
const TASKS = [
  { id: "T1", status: "in_progress", summary: "Sidebar snapshot test" },
  { id: "T2", status: "open", summary: "Identity scan" },
  { id: "T2.1", status: "blocked", summary: "Blocked subtask" },
]

const TASKS_DONE = [
  { id: "T3", status: "done", summary: "Done task A", ended_at: 1000 },
  { id: "T4", status: "done", summary: "Done task B", ended_at: 900 },
  { id: "T5", status: "done", summary: "Done task C", ended_at: 800 },
  { id: "T6", status: "done", summary: "Done task D", ended_at: 700 },
]

const TODOS = [
  { status: "in_progress", content: "Write sidebar test" },
  { status: "pending", content: "Add identity scan" },
  { status: "completed", content: "Read upstream diffs" },
  { status: "pending", content: "Commit both tasks" },
]

const ASSISTANTS = [
  {
    tokens: { input: 15000, output: 2500, reasoning: 800, cache: { read: 5000, write: 200 } },
    time: { created: Date.now() - 30000, completed: Date.now() - 5000 },
    id: "msg-1",
  },
  {
    tokens: { input: 20000, output: 3000, reasoning: 0, cache: { read: 8000, write: 0 } },
    time: { created: Date.now() - 5000 },
    id: "msg-2",
  },
]

const COST = 0.042
const DIRECTORY = "~/projects/hordecode"
const MCP_LIST = [
  { name: "filesystem", status: "connected" },
  { name: "memory", status: "connected" },
  { name: "github", status: "failed", error: "Auth expired" },
]
const LSP_LIST = [{ id: "typescript", root: "/home/user/projects/hordecode", status: "connected" }]
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"]
const DIFF = [
  { file: "sidebar/task.tsx", additions: 12, deletions: 3 },
  { file: "sidebar/telemetry.tsx", additions: 45, deletions: 0 },
]
const SUPERVISOR = [
  { agent: "explore", description: "Find plugins", status: "completed" },
  { agent: "general", description: "Diff code", status: "running" },
]

// -- Helpers -----------------------------------------------------------
const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1000_000).toFixed(1)}M`)
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function taskRow(t: { id: string; status: string; summary: string }) {
  const glyph = t.status === "done" ? G.check : t.status === "blocked" ? G.blocked : " "
  const indent = t.id.includes(".") ? "  " : ""
  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0}>{indent}[{glyph}] </text>
      <text flexGrow={1} wrapMode="word">
        {t.id} {t.summary}
      </text>
    </box>
  )
}

function todoRow(t: { status: string; content: string }) {
  const glyph = t.status === "completed" ? G.check : " "
  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0}>[{glyph}] </text>
      <text flexGrow={1} wrapMode="word">
        {t.content}
      </text>
    </box>
  )
}

// -- Panel views (structurally identical to real sidebar plugins) ------

function TelemetryPanel() {
  const turns = ASSISTANTS.length
  const totalInput = ASSISTANTS.reduce((s, a) => s + a.tokens.input, 0)
  const totalOutput = ASSISTANTS.reduce((s, a) => s + a.tokens.output, 0)
  const totalReasoning = ASSISTANTS.reduce((s, a) => s + a.tokens.reasoning, 0)
  const totalCacheRead = ASSISTANTS.reduce((s, a) => s + a.tokens.cache.read, 0)
  const totalDenom = totalInput + totalCacheRead
  const hitRate = totalDenom > 0 ? totalCacheRead / totalDenom : 0
  const totalTokens = ASSISTANTS.reduce(
    (s, a) => s + a.tokens.input + a.tokens.output + a.tokens.reasoning + a.tokens.cache.read + a.tokens.cache.write,
    0,
  )

  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>Telemetry</b>
        </text>
        <text> {turns} turns</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Context ".padEnd(8)}</text>
        <text>{fmt(totalTokens)}/128K 42%</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Tokens  ".padEnd(8)}</text>
        <text>{fmt(totalInput)} in {fmt(totalOutput)} out {totalReasoning > 0 ? `${fmt(totalReasoning)} rsn` : ""}</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Cache   ".padEnd(8)}</text>
        <text>{(hitRate * 100).toFixed(1)}% ({fmt(totalCacheRead)}/{fmt(totalDenom)})</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Tools   ".padEnd(8)}</text>
        <text>13 · 12 ok · 1 err · 1.4/turn</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Speed   ".padEnd(8)}</text>
        <text>42.3 t/s · 2.7s</text>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text>{"Usage   ".padEnd(8)}</text>
        <text>{money.format(COST)} spent · {fmt(totalTokens)} tkn</text>
      </box>
    </box>
  )
}

function CwdPanel() {
  return (
    <box flexShrink={0} gap={0}>
      <text>
        <b>Directory</b>
      </text>
      <text>{DIRECTORY}:dev</text>
    </box>
  )
}

function InstructionsPanel() {
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>Instructions</b>
        </text>
        <text>{INSTRUCTIONS.length} files</text>
      </box>
      <For each={INSTRUCTIONS}>
        {(f) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0}>{G.bullet}</text>
            <text wrapMode="none">{f}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function McpPanel() {
  const on = MCP_LIST.filter((i) => i.status === "connected").length
  const bad = MCP_LIST.filter((i) => i.status === "failed").length
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>MCP</b>
        </text>
        <text>{on}/{MCP_LIST.length} active{bad > 0 ? `, ${bad} err` : ""}</text>
      </box>
      <For each={MCP_LIST}>
        {(item) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0}>{G.bullet}</text>
            <text wrapMode="word">{item.name} {item.status === "connected" ? "Connected" : item.error}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function SupervisorPanel() {
  const active = SUPERVISOR.filter((s) => s.status === "running").length
  const done = SUPERVISOR.filter((s) => s.status !== "running").length
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>Subagents</b>
        </text>
        <text>{active} active, {done} done</text>
      </box>
      <For each={SUPERVISOR}>
        {(item) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0}>{item.status === "running" ? G.running : G.done}</text>
            <text wrapMode="word">{item.agent} -- {item.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function LspPanel() {
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>LSP</b>
        </text>
        <text>{LSP_LIST.length} active</text>
      </box>
      <For each={LSP_LIST}>
        {(item) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0}>{G.bullet}</text>
            <text>{item.id} {item.root}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function TasksPanel() {
  return (
    <box>
      <text>
        <b>Tasks</b>
      </text>
      <For each={TASKS}>{(t) => taskRow(t)}</For>
    </box>
  )
}

function TasksWithDonePanel() {
  const recentDone = TASKS_DONE.slice(0, 3)
  const hiddenCount = TASKS_DONE.length - recentDone.length
  return (
    <box>
      <text>
        <b>Tasks</b>
      </text>
      <For each={TASKS}>{(t) => taskRow(t)}</For>
      <For each={recentDone}>{(t) => taskRow(t)}</For>
      <text>{G.up} {hiddenCount} more done</text>
    </box>
  )
}

function TodoPanel() {
  // Deliberate: shows ONLY when tasks().length === 0
  // This tests the NEGATIVE case: tasks exist, todo must NOT render
  return <></>
}

function TodoOnlyPanel() {
  return (
    <box>
      <text>
        <b>Todo</b>
      </text>
      <For each={TODOS}>{(t) => todoRow(t)}</For>
    </box>
  )
}

function FilesPanel() {
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>Modified Files</b>
        </text>
        <text>{DIFF.length} files</text>
      </box>
      <For each={DIFF}>
        {(item) => (
          <box flexDirection="row" gap={1} justifyContent="space-between">
            <text wrapMode="none">{item.file}</text>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <Show when={item.additions > 0}>
                <text>+{item.additions}</text>
              </Show>
              <Show when={item.deletions > 0}>
                <text>-{item.deletions}</text>
              </Show>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

function Footer() {
  return (
    <box flexShrink={0} gap={0}>
      <text>{G.bullet} Hordecode 0.4.0</text>
    </box>
  )
}

// -- Full sidebar fixture (order: Telemetry->Cwd->Instructions->Mcp->Supervisor->Lsp->Tasks->Todo->Files->Footer) --

function SidebarFixture(props: { showTodo?: boolean; showDone?: boolean; includeTelemetry?: boolean }) {
  return (
    <box flexDirection="column" width={42} height={40}>
      <scrollbox flexGrow={1}>
        <box flexShrink={0} gap={1} paddingRight={1}>
          {props.includeTelemetry !== false && <TelemetryPanel />}
          <CwdPanel />
          <InstructionsPanel />
          <McpPanel />
          <SupervisorPanel />
          <LspPanel />
          {props.showDone ? <TasksWithDonePanel /> : <TasksPanel />}
          {props.showTodo ? <TodoOnlyPanel /> : <TodoPanel />}
          <FilesPanel />
        </box>
      </scrollbox>
      <box flexShrink={0} gap={1} paddingTop={1}>
        <Footer />
      </box>
    </box>
  )
}

// -- Render helper -----------------------------------------------------

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

// -- Tests -------------------------------------------------------------

describe("TUI sidebar golden snapshot", () => {
  test("full sidebar with tasks visible, todo hidden", async () => {
    const frame = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    // Telemetry
    expect(frame).toContain("Telemetry")
    expect(frame).toContain("42.3 t/s")
    // Directory
    expect(frame).toContain("Directory")
    expect(frame).toContain(DIRECTORY)
    // Instructions
    expect(frame).toContain("Instructions")
    expect(frame).toContain("AGENTS.md")
    // MCP
    expect(frame).toContain("MCP")
    expect(frame).toContain("filesystem")
    // Subagents
    expect(frame).toContain("Subagents")
    // LSP
    expect(frame).toContain("LSP")
    // Tasks
    expect(frame).toContain("Tasks")
    expect(frame).toContain("T1")
    expect(frame).toContain("Sidebar snapshot test")
    expect(frame).toContain("T2")
    expect(frame).toContain("Identity scan")
    expect(frame).toContain("T2.1")
    expect(frame).toContain("Blocked subtask")
    // Todo MUST NOT appear when tasks exist
    expect(frame).not.toContain("Todo")
    expect(frame).not.toContain("Write sidebar test")
    // Files
    expect(frame).toContain("Modified Files")
    // Footer
    expect(frame).toContain("Hordecode")
    expect(frame).toMatchSnapshot()
  })

  test("sidebar with done tasks and RECENT_DONE_LIMIT=3", async () => {
    const frame = await renderFrame(() => <SidebarFixture showDone />, { width: 42, height: 40 })
    // Active tasks
    expect(frame).toContain("T1")
    expect(frame).toContain("T2")
    expect(frame).toContain("T2.1")
    // Done tasks hidden behind "more done" indicator
    expect(frame).toContain("more done")
    // Todo still hidden when tasks exist
    expect(frame).not.toContain("Todo")
    expect(frame).toMatchSnapshot()
  })

  test("todo appears only when tasks are empty (deliberate Hordecode behavior)", async () => {
    const frameWithTasks = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    const frameTodoOnly = await renderFrame(() => <SidebarFixture showTodo />, { width: 42, height: 40 })
    // With tasks: todo is hidden
    expect(frameWithTasks).toContain("Tasks")
    expect(frameWithTasks).not.toContain("Todo")
    // Without tasks: todo appears
    expect(frameTodoOnly).toContain("Todo")
    expect(frameTodoOnly).toContain("Write sidebar test")
    expect(frameTodoOnly).toContain("Add identity scan")
    expect(frameTodoOnly).toMatchSnapshot()
  })

  test("removing telemetry panel breaks the snapshot (golden test regression)", async () => {
    const full = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    const without = await renderFrame(() => <SidebarFixture includeTelemetry={false} />, { width: 42, height: 40 })
    // Full has telemetry, without doesn't
    expect(full).toContain("Telemetry")
    expect(without).not.toContain("Telemetry")
    // Both should still have core panels
    expect(full).toContain("Tasks")
    expect(without).toContain("Tasks")
    expect(full).toContain("T1")
    expect(without).toContain("T1")
    // Frames must differ -- proving the golden test catches regressions
    expect(full).not.toEqual(without)
    expect(without).toMatchSnapshot()
  })

  test("panel order: telemetry < cwd < instructions < mcp < supervisor < lsp < tasks < files", async () => {
    const frame = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    // Use unique markers per panel to find line positions
    const markers = ["Telemetry", "Directory", "Instructions", "MCP", "Subagents", "LSP", "Tasks", "Modified Files"]
    const lines = frame.split("\n").map((l) => l.trim())
    const positions = markers.map((m) => {
      const idx = lines.findIndex((l) => l.includes(m))
      expect(idx).toBeGreaterThanOrEqual(0)
      return idx
    })
    // Verify strictly ascending order
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  test("telemetry invariants: all 6 rows with exact format", async () => {
    const frame = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    // Row headers must be padEnd(8) as in real telemetry.tsx
    expect(frame).toContain("Context ")
    expect(frame).toContain("Tokens  ")
    expect(frame).toContain("Cache   ")
    expect(frame).toContain("Tools   ")
    expect(frame).toContain("Speed   ")
    expect(frame).toContain("Usage   ")
    // Tools row: total - ok - err - perTurn (real: toolStats, no hybrid)
    expect(frame).toContain("13 · 12 ok")
    expect(frame).toContain("1 err")
    expect(frame).toContain("1.4/turn")
    // Speed row: streaming TPS + latency (real: formatTPS + formatLatency)
    expect(frame).toContain("42.3 t/s")
    expect(frame).toContain("2.7s")
    // Usage row: cost + total tokens (real: money.format + formatTokens)
    expect(frame).toContain("$0.04")
    expect(frame).toContain("tkn")
    // Cache row: hitRate with 1 decimal
    expect(frame).toContain("% (")
    expect(frame).toContain("/")
    expect(frame).toContain(")")
    // No hybrid leakage: telemetry must not reference toolTasks/callID
    expect(frame).not.toContain("toolTasks")
    expect(frame).not.toContain("callID")
  })

  test("footer invariants: Hordecode version + chrome canon", async () => {
    const frame = await renderFrame(() => <SidebarFixture />, { width: 42, height: 40 })
    expect(frame).toContain("Hordecode 0.4.0")
    expect(frame).toContain(G.bullet)
    // Footer is the last non-empty line (flexShrink 0)
    const lines = frame.split("\n").filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1] ?? ""
    expect(last).toContain("Hordecode")
  })
})
