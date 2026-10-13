/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LanguageProvider } from "../../src/context/language"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, type Route } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { SubagentFooter } from "../../src/routes/session/subagent-footer"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../fixture/tui-sdk"

//  regression guard.
//
// fork isolates each subagent turn in its own child session
// (packages/supervisor/src/spawn.ts:900-929 registers the supervisor row under
// child.id), so the child-session route carries no `agentID` and the registry
// lookup in `subagentInfo` cannot match a row. Before this guard the footer
// therefore read "Subagent (0 of 1)" while viewing the only subagent.
//
// opencode 1.18.15 computes the counter from SIBLING sessions instead
// (packages/tui/src/routes/session/subagent-footer.tsx:24-30): siblings are the
// sessions sharing the current session's parentID, sorted by time.created, and
// the index is the current session's 1-based position among them.

const parentID = "ses_hr16_parent"
const childID = "ses_hr16_child"

function session(input: { id: string; title: string; parentID?: string; created: number }) {
  return {
    id: input.id,
    slug: input.id,
    projectID: "proj_test",
    directory,
    parentID: input.parentID,
    title: input.title,
    version: "1.18.15",
    time: { created: input.created, updated: input.created },
  }
}

const parent = session({ id: parentID, title: "main session", created: 1000 })
// Title shape produced by packages/supervisor/src/spawn.ts:827/:903, matching
// opencode tool/task.ts:160 -- the footer label regex reads it.
const child = session({ id: childID, title: "subagent run (@general subagent)", parentID, created: 2000 })

// The supervisor registry keys the subagent row by the CHILD session
// (packages/supervisor/src/spawn.ts:915-929), which is why the child-session
// view has a registry row but no `agentID` to match it with.
const subagentRow = {
  supervisor_id: "general-1",
  session_id: childID,
  mode: "subagent",
  status: "running",
  agent: "general",
  description: "hr16 subagent",
  time_created: 2000,
  time_updated: 2000,
}

// Hydration lag: the routed session row has not loaded yet, but its child (and
// the child's registry row) has -- the state where a registry-only fallthrough
// would report "0 of 1" for a session that is not even the child.
const pendingParentID = "ses_hr16_pending_parent"
const pendingChildID = "ses_hr16_pending_child"
const pendingChild = session({
  id: pendingChildID,
  title: "pending subagent (@general subagent)",
  parentID: pendingParentID,
  created: 3000,
})
const pendingRow = {
  supervisor_id: "general-2",
  session_id: pendingChildID,
  mode: "subagent",
  status: "running",
  agent: "general",
  description: "pending subagent",
  time_created: 3000,
  time_updated: 3000,
}

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function renderFooter(root: string, input: { route: Route; hydrate: string[] }) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const sessions: Record<string, unknown> = {
    [parentID]: parent,
    [childID]: child,
    [pendingChildID]: pendingChild,
  }
  const calls = createFetch((url) => {
    const single = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (single && sessions[single[1]]) return json(sessions[single[1]])
    if (url.pathname === `/session/${childID}/supervisor`) return json([subagentRow])
    if (url.pathname === `/session/${pendingChildID}/supervisor`) return json([pendingRow])
    if (/^\/session\/[^/]+\/(message|todo|diff|task|supervisor)$/.test(url.pathname)) return json([])
    return undefined
  })
  const events = createEventSource()
  let sync: ReturnType<typeof useSync> | undefined

  function Probe() {
    const ctx = useSync()
    sync = ctx
    onMount(() => {
      void Promise.all(input.hydrate.map((id) => ctx.session.sync(id)))
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={directory} paths={{ home: root, state, worktree: root }}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <PermissionProvider>
                <ProjectProvider>
                  <ExitProvider exit={() => {}}>
                    <SyncProvider>
                      <Probe />
                      <RouteProvider initialRoute={input.route}>
                        <OpencodeKeymapProvider keymap={keymap}>
                          <TuiConfigProvider config={resolvedConfig}>
                            <LanguageProvider>
                              <ThemeProvider mode="dark">
                                <SubagentFooter />
                              </ThemeProvider>
                            </LanguageProvider>
                          </TuiConfigProvider>
                        </OpencodeKeymapProvider>
                      </RouteProvider>
                    </SyncProvider>
                  </ExitProvider>
                </ProjectProvider>
              </PermissionProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 10 })
  await wait(() => sync?.data.session.length === input.hydrate.length)
  await wait(() => input.hydrate.every((id) => sync?.session.get(id) !== undefined))

  // The footer always paints a bordered box, so an empty frame means the first
  // paint pass has not flushed layout yet -- retry instead of racing it.
  const capture = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (frame.trim().length > 0) return frame
      await Bun.sleep(25)
    }
    return app.captureCharFrame()
  }

  return { frame: await capture(), destroy: () => app.renderer.destroy() }
}

test("child-session view of the only subagent reads 1 of 1", async () => {
  await using tmp = await tmpdir()
  const result = await renderFooter(tmp.path, {
    route: { type: "session", sessionID: childID },
    hydrate: [parentID, childID],
  })
  try {
    // Label comes from the real title regex (subagent-footer.tsx:36); the
    // registry row is unreachable here because the view carries no agentID.
    expect(result.frame).toContain("General")
    expect(result.frame).not.toContain("Subagent")
    expect(result.frame).toContain("1 of 1")
  } finally {
    result.destroy()
  }
})

// Hydration lag: the routed session row is not in the store yet while a child
// of it (and that child's registry row) already is. opencode hides the counter
// entirely in that state (subagent-footer.tsx:18-19); falling through to the
// registry path instead reports "0 of 1" for a session that is not the child.
test("unloaded session hides the counter instead of reporting 0 of N", async () => {
  await using tmp = await tmpdir()
  const result = await renderFooter(tmp.path, {
    route: { type: "session", sessionID: pendingParentID },
    hydrate: [pendingChildID],
  })
  try {
    // "Subagent" here is the no-session fallback label (the routed row never
    // hydrates), not the title regex result; the counter is what must vanish.
    expect(result.frame).toContain("Subagent")
    expect(result.frame).not.toContain("0 of")
    expect(result.frame).not.toContain(" of ")
  } finally {
    result.destroy()
  }
})

// The parent view keeps the registry path untouched by this fix: the widened
// registry list matches the child's row but no `agentID` matches it, so the
// footer still reports index 0 (outside 's scope -- child-session routing
// is what puts the user in front of a subagent).
test("parent view of a session with one subagent keeps the registry path", async () => {
  await using tmp = await tmpdir()
  const result = await renderFooter(tmp.path, {
    route: { type: "session", sessionID: parentID },
    hydrate: [parentID, childID],
  })
  try {
    expect(result.frame).toContain("Subagent")
    expect(result.frame).toContain("0 of 1")
  } finally {
    result.destroy()
  }
})
