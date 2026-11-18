import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// K4: the mounted v2 config loader (core PluginInternal -> ConfigExternalPlugin)
// imports a plugin while the location service map for a request is built
// (httpapi/server.ts:289). These tests drive that production entry point: the core
// loader, the v2 config walk and the trust store are real. A plugin in the
// user-owned global config directory is the positive control: it proves the loader
// ran, so the project marker's absence is a decision, not a timing artefact.

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string) {
  const headers = new Headers()
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { headers }), context)
}

function pluginFile(marker: string) {
  return [
    'import { writeFileSync } from "fs"',
    `writeFileSync(${JSON.stringify(marker)}, "imported")`,
    "export const Marker = async () => ({})",
    "",
  ].join("\n")
}

const markerFile = (dir: string, name: string) => path.join(dir, name)
const exists = (file: string) => fs.stat(file).then(() => true, () => false)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(file: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await exists(file)) return true
    await sleep(25)
  }
  return exists(file)
}

const controlPlugin = path.join(Global.Path.config, "plugin", "k4-control.ts")

let markerDir = ""

beforeEach(async () => {
  markerDir = await fs.mkdtemp(path.join(process.env.HORDECODE_TEST_TMP ?? os.tmpdir(), "k4-v2-config-"))
  // Positive control: the global config directory is user-owned, so its plugin
  // loads whatever the project's trust level is. It runs from the same loader pass.
  await fs.mkdir(path.dirname(controlPlugin), { recursive: true })
  await Bun.write(controlPlugin, pluginFile(markerFile(markerDir, "control.txt")))
})

afterEach(async () => {
  await fs.rm(controlPlugin, { force: true }).catch(() => undefined)
  await fs.rm(markerDir, { recursive: true, force: true }).catch(() => undefined)
  await disposeAllInstances()
  await resetDatabase()
})

describe("project plugin trust at the mounted v2 config loader", () => {
  test("an untrusted project plugin from the mounted v2 config loader is not imported", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = path.join(tmp.path, "listed.ts")
    await Bun.write(plugin, pluginFile(markerFile(markerDir, "project.txt")))
    await Bun.write(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ plugin: [`file://${plugin}`] }),
    )

    const response = await request("/api/command", tmp.path)
    expect(response.status).toBe(200)

    expect(await waitFor(markerFile(markerDir, "control.txt"))).toBe(true)
    // The loop imports the project entry next in the same pass (project document
    // directly after the global directory); give the denied branch a moment.
    await sleep(1000)
    expect(await exists(markerFile(markerDir, "project.txt"))).toBe(false)
  }, 30_000)

  test("a trusted project plugin from the mounted v2 config loader is imported", async () => {
    await using tmp = await tmpdir({ git: true, trust: true })
    const plugin = path.join(tmp.path, "listed.ts")
    await Bun.write(plugin, pluginFile(markerFile(markerDir, "project.txt")))
    await Bun.write(
      path.join(tmp.path, "hordecode.json"),
      JSON.stringify({ plugin: [`file://${plugin}`] }),
    )

    const response = await request("/api/command", tmp.path)
    expect(response.status).toBe(200)

    expect(await waitFor(markerFile(markerDir, "project.txt"))).toBe(true)
  }, 30_000)
})
