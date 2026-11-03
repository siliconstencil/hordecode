/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { LanguageProvider } from "../../src/context/language"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { TaskItem, taskGlyph } from "../../src/component/task-item"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

describe("task item marker", () => {
  test("taskGlyph maps each status", () => {
    expect(taskGlyph("done")).toBe("✓")
    expect(taskGlyph("blocked")).toBe("⏸")
    expect(taskGlyph("abandoned")).toBe("✗")
    expect(taskGlyph("open")).toBe(" ")
  })

  // The sidebar keeps a row's component (<Index>) and only changes its props, so a task that goes from
  // open to done in place must redraw its marker.
  test("a row whose status changes to done shows the check mark", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    const [status, setStatus] = createSignal("open")

    function Harness() {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const config = createTuiResolvedConfig({})
      onCleanup(registerOpencodeKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <LanguageProvider>
                  <ThemeProvider mode="dark">
                    <TaskItem id="T1" status={status()} summary="count files" depth={0} />
                  </ThemeProvider>
                </LanguageProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </TestTuiContexts>
      )
    }

    const app = await testRender(() => <Harness />, { width: 40, height: 2 })
    try {
      const frame = async (text: string) => {
        const start = Date.now()
        while (Date.now() - start < 2000) {
          await app.renderOnce()
          if (app.captureCharFrame().includes(text)) return true
          await Bun.sleep(10)
        }
        return false
      }
      expect(await frame("[ ] T1")).toBe(true)
      setStatus("done")
      expect(await frame("[✓] T1")).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})
