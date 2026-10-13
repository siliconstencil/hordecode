/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { createSignal, onCleanup, Show } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../src/keymap"
import { parentNavigateTarget } from "../../src/routes/session/index"

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

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// Replicates the prompt's history registration (component/prompt/index.tsx:878-908)
// including its cleanup (:643-649): the target signal is cleared when the prompt
// unmounts, which is what retires the layer.
function PromptHistoryLayer(props: { counters: { history: number }; config: Config }) {
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  useBindings(() => ({
    target: inputTarget,
    enabled: inputTarget() !== undefined,
    commands: [
      {
        name: "prompt.history.previous",
        title: "Previous prompt history",
        run: () => {
          props.counters.history++
        },
      },
    ],
    bindings: props.config.keybinds.get("prompt.history.previous"),
  }))

  onCleanup(() => setInputTarget(undefined))

  return (
    <textarea
      ref={(r: TextareaRenderable) => {
        setInputTarget(r)
        r.focus()
      }}
    />
  )
}

// Replicates the session route's two registrations: the untargeted command layer
// (routes/session/index.tsx:1176-1178) and the session binding layer (:1189-1192).
function Harness(props: { counters: { parent: number; history: number }; promptMounted: () => boolean }) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createResolvedKeymapConfig()
  const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
  const offCommands = keymap.registerLayer({
    commands: [
      {
        name: "session.parent",
        title: "Go to parent session",
        run: () => {
          props.counters.parent++
        },
      },
    ],
  })
  const offBindings = keymap.registerLayer({
    mode: OPENCODE_BASE_MODE,
    bindings: config.keybinds.gather("session", ["session.parent"]),
  })
  onCleanup(() => {
    offBindings()
    offCommands()
    offKeymap()
  })

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <box flexDirection="column">
        <Show when={props.promptMounted()}>
          <PromptHistoryLayer counters={props.counters} config={config} />
        </Show>
      </box>
    </OpencodeKeymapProvider>
  )
}

test("up routes to session.parent while the prompt is unfocused or unmounted", async () => {
  const counters = { parent: 0, history: 0 }
  const [promptMounted, setPromptMounted] = createSignal(true)
  const app = await testRender(() => <Harness counters={counters} promptMounted={promptMounted} />)

  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    app.mockInput.pressArrow("up")
    expect(counters).toEqual({ parent: 0, history: 1 })

    app.renderer.currentFocusedEditor?.blur()
    await wait(() => !app.renderer.currentFocusedEditor)

    app.mockInput.pressArrow("up")
    expect(counters).toEqual({ parent: 1, history: 1 })

    setPromptMounted(false)
    await Bun.sleep(20)

    app.mockInput.pressArrow("up")
    expect(counters).toEqual({ parent: 2, history: 1 })
  } finally {
    app.renderer.destroy()
  }
})

test("session.parent target prefers the child session's parentID", () => {
  expect(parentNavigateTarget({ sessionID: "child", agentID: "sub", parentID: "parent" })).toEqual({
    type: "session",
    sessionID: "parent",
  })
  expect(parentNavigateTarget({ sessionID: "child", agentID: "sub" })).toEqual({ type: "session", sessionID: "child" })
  expect(parentNavigateTarget({ sessionID: "child", parentID: "parent" })).toEqual({
    type: "session",
    sessionID: "parent",
  })
  expect(parentNavigateTarget({ sessionID: "child" })).toBeUndefined()
})

// Each clause of this memo has been dropped once: the child-session condition,
// and the slice-view condition that replaced it. Losing either re-exposes the
// prompt in a view where "up" has to reach the parent command instead of prompt
// history, so both are pinned here.
test("the session prompt gate keeps the child-session and slice-view conditions", () => {
  const lines = readFileSync(join(import.meta.dir, "..", "..", "src", "routes", "session", "index.tsx"), "utf-8").split(
    "\n",
  )
  const start = lines.findIndex((line) => line.includes("const visible = createMemo"))
  expect(start).toBeGreaterThan(-1)

  const block = lines.slice(start, start + 4).join("\n")
  expect(block).toContain("!session()?.parentID")
  expect(block).toContain('currentAgentID() === "main"')
  expect(block).toContain("permissions().length === 0")
  expect(block).toContain("questions().length === 0")
})
