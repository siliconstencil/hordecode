import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import { resolveInWorkspace, makeFileHooks } from "@opencode-ai/workflow/workspace"

const ROOT = "/srv/workflow-root"

describe("resolveInWorkspace (jail boundary)", () => {
  it("resolves an in-bounds relative path to an absolute path inside the root", () => {
    const abs = resolveInWorkspace(ROOT, "sub/file.txt")
    expect(abs).toBe(path.join(ROOT, "sub/file.txt"))
  })

  it("returns the root itself for an empty relative path", () => {
    expect(resolveInWorkspace(ROOT, "")).toBe(ROOT)
  })

  it("allows a path with .. that still resolves inside the root", () => {
    const abs = resolveInWorkspace(ROOT, "a/../b.txt")
    expect(abs).toBe(path.join(ROOT, "b.txt"))
  })

  it("throws when a parent traversal escapes the root", () => {
    expect(() => resolveInWorkspace(ROOT, "../escape.txt")).toThrow(/escapes the workspace root/)
  })

  it("throws when an absolute path is outside the root", () => {
    expect(() => resolveInWorkspace(ROOT, "/etc/passwd")).toThrow(/escapes the workspace root/)
  })
})

describe("makeFileHooks (jailed file host)", () => {
  let dir: string
  let hooks: ReturnType<typeof makeFileHooks>

  beforeEach(async () => {
    dir = path.join("/tmp", `wf-ws-${Math.random().toString(36).slice(2, 10)}`)
    await Bun.write(path.join(dir, ".sentinel"), "")
    hooks = makeFileHooks(dir)
  })

  afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet()
  })

  it("exists() is false for a missing file and true after write", async () => {
    expect(await hooks.exists("missing.txt")).toBe(false)
    await hooks.writeFile("created.txt", "hi")
    expect(await hooks.exists("created.txt")).toBe(true)
  })

  it("readFile returns null for a missing file and its content once written", async () => {
    expect(await hooks.readFile("gone.txt")).toBeNull()
    await hooks.writeFile("note.txt", "payload")
    expect(await hooks.readFile("note.txt")).toBe("payload")
  })

  it("writeFile then readFile roundtrips content", async () => {
    await hooks.writeFile("a/b/c.txt", "nested")
    expect(await hooks.readFile("a/b/c.txt")).toBe("nested")
  })

  it("readFile throws when the path escapes the jail", async () => {
    await expect(hooks.readFile("../escape.txt")).rejects.toThrow(/escapes the workspace root/)
  })

  it("glob returns relative paths confined to the root, sorted", async () => {
    await hooks.writeFile("z.txt", "1")
    await hooks.writeFile("a.txt", "2")
    await hooks.writeFile("sub/c.txt", "3")
    const names = await hooks.glob("*")
    expect(names.every((n) => !n.startsWith("..") && !path.isAbsolute(n))).toBe(true)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
    expect(names).toContain("a.txt")
    expect(names).toContain("z.txt")
  })
})
