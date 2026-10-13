/** @jsxImportSource @opentui/solid */
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { createSignal, onCleanup } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../src/keymap"
import { childAppExit } from "../../src/routes/session/index"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

type Config = ReturnType<typeof createResolvedKeymapConfig>
type Counters = { abort: number; exit: number; appExit: number }

// Replicates the two registrations this behaviour depends on: the application-wide
// exit layer (app.tsx:1212-1219) and the child-view layer added to the session
// route (routes/session/index.tsx, next to the session command layer).
function Harness(props: {
  counters: Counters
  child: () => boolean
  status: () => string | undefined
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config: Config = createResolvedKeymapConfig()
  const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
  const offApp = keymap.registerLayer({
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Exit the app",
        run: () => {
          props.counters.appExit++
        },
      },
    ],
    bindings: config.keybinds.gather("app_exit", ["app.exit"]),
  })
  onCleanup(() => {
    offApp()
    offKeymap()
  })

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ChildExitLayer counters={props.counters} child={props.child} status={props.status} config={config} />
    </OpencodeKeymapProvider>
  )
}

function ChildExitLayer(props: { counters: Counters; child: () => boolean; status: () => string | undefined; config: Config }) {
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    priority: 1,
    enabled: props.child,
    commands: [
      {
        name: "session.exit",
        title: "Abort the running turn, or exit the app",
        run: () => {
          childAppExit({
            statusType: props.status(),
            abort: () => {
              props.counters.abort++
            },
            exit: () => {
              props.counters.exit++
            },
          })
        },
      },
    ],
    bindings: props.config.keybinds.gather("app_exit", ["app.exit"]).map((binding) => ({
      ...binding,
      cmd: "session.exit",
    })),
  }))

  return null
}

test("a running turn is aborted instead of exiting the app", async () => {
  const counters: Counters = { abort: 0, exit: 0, appExit: 0 }
  const [child, setChild] = createSignal(true)
  const [status, setStatus] = createSignal<string | undefined>("busy")
  const app = await testRender(() => <Harness counters={counters} child={child} status={status} />)

  try {
    await Bun.sleep(20)

    app.mockInput.pressKey("c", { ctrl: true })
    expect(counters).toEqual({ abort: 1, exit: 0, appExit: 0 })

    setStatus("retry")
    await Bun.sleep(20)
    app.mockInput.pressKey("c", { ctrl: true })
    expect(counters).toEqual({ abort: 2, exit: 0, appExit: 0 })

    setStatus("idle")
    await Bun.sleep(20)
    app.mockInput.pressKey("c", { ctrl: true })
    expect(counters).toEqual({ abort: 2, exit: 1, appExit: 0 })

    // Leader view: the session layer stands down and the application exit layer
    // keeps the key, so the app still exits from the leader view.
    setChild(false)
    await Bun.sleep(20)
    app.mockInput.pressKey("c", { ctrl: true })
    expect(counters).toEqual({ abort: 2, exit: 1, appExit: 1 })
  } finally {
    app.renderer.destroy()
  }
})

test("the exit decision follows the session status", () => {
  const counters: Counters = { abort: 0, exit: 0, appExit: 0 }
  const abort = () => {
    counters.abort++
  }
  const exit = () => {
    counters.exit++
  }

  childAppExit({ statusType: "busy", abort, exit })
  expect(counters).toEqual({ abort: 1, exit: 0, appExit: 0 })

  childAppExit({ statusType: "idle", abort, exit })
  expect(counters).toEqual({ abort: 1, exit: 1, appExit: 0 })

  childAppExit({ abort, exit })
  expect(counters).toEqual({ abort: 1, exit: 2, appExit: 0 })
})

// The guard, the priority and the abort wiring are the whole port: without the
// priority the application exit layer wins the key, without the guard the leader
// view loses its exit, and without childAppExit the turn is never aborted.
test("the session route claims the exit key only while a child view is on screen", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "routes", "session", "index.tsx"), "utf-8")
  expect(source).toContain('gather("app_exit", ["app.exit"])')
  expect(source).toContain('cmd: "session.exit"')
  expect(source).toContain("priority: 1")
  expect(source).toContain("enabled: () => !!(session()?.parentID || route.agentID)")
  expect(source).toContain("childAppExit({")
  expect(source).toContain('sdk.client.session.abort({ sessionID: route.sessionID })')
})
