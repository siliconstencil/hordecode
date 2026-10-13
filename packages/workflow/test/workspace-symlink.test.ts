import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { resolveInWorkspace } from "../src/workspace"

describe("resolveInWorkspace (symlink boundary)", () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-symlink-root-"))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-symlink-outside-"))
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it("rejects a symlink pointing outside the root", () => {
    if (process.platform === "win32") {
      console.log("skipped on win32")
      return
    }
    fs.symlinkSync(outsideDir, path.join(rootDir, "link"), "dir")
    expect(() => resolveInWorkspace(rootDir, "link/secret.txt")).toThrow(/escapes/)
  })

  it("rejects resolving the symlink itself when it points outside root", () => {
    if (process.platform === "win32") {
      console.log("skipped on win32")
      return
    }
    fs.symlinkSync(outsideDir, path.join(rootDir, "link"), "dir")
    expect(() => resolveInWorkspace(rootDir, "link")).toThrow(/escapes/)
  })

  it("allows resolving a new file path inside root that does not exist", () => {
    const result = resolveInWorkspace(rootDir, "new/file.txt")
    expect(result).toContain(rootDir)
    expect(result).toBe(path.join(rootDir, "new/file.txt"))
  })

  it("allows resolving an existing file inside root", () => {
    const filePath = path.join(rootDir, "existing.txt")
    fs.writeFileSync(filePath, "content")
    const result = resolveInWorkspace(rootDir, "existing.txt")
    expect(result).toBe(filePath)
  })

  it("allows resolving a nested existing file inside root", () => {
    const dir = path.join(rootDir, "sub/deep")
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, "file.txt")
    fs.writeFileSync(filePath, "data")
    const result = resolveInWorkspace(rootDir, "sub/deep/file.txt")
    expect(result).toBe(filePath)
  })

  it("allows symlinks that point inside the root", () => {
    const targetFile = path.join(rootDir, "target.txt")
    fs.writeFileSync(targetFile, "content")
    const linkPath = path.join(rootDir, "link-inside")
    if (process.platform !== "win32") {
      fs.symlinkSync(targetFile, linkPath, "file")
    }
    // Should succeed or skip on win32
    const result = resolveInWorkspace(rootDir, "link-inside")
    expect(result).toBe(linkPath)
  })
})
