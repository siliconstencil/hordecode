import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveMainGitDir, resolveProjectId } from "../src/project-id"

const dirs: string[] = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-smoke-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("project package smoke", () => {
  // src/project.ts reaches src/instance.ts through core/effect/cross-spawn-spawner and core/effect/instance-state,
  // so instance.ts must not read Project.Service while it is loading.
  for (const entry of ["../src/index", "../src/project", "../src/instance"]) {
    test(`${entry} imports first in a fresh process`, async () => {
      const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(import.meta.resolve(entry))})`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    })
  }

  test("a directory outside git has no main git dir and gets a stable project id", () => {
    const dir = tmp()
    expect(resolveMainGitDir(dir)).toBeNull()
    const id = resolveProjectId(dir)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveProjectId(dir)).toBe(id)
    expect(fs.readFileSync(path.join(dir, ".hordecode-project-id"), "utf8").trim()).toBe(id)
  })
})
