import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { AppFileSystem } from "../src/filesystem"
import { resolveHordecodeHome } from "../src/global"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "shared-fs-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(path.join(root, "a", "b"), { recursive: true })
writeFileSync(path.join(root, "marker.txt"), "root")
writeFileSync(path.join(root, "a", "marker.txt"), "a")
writeFileSync(path.join(root, "a", "b", "note.md"), "note")

const run = <A>(effect: Effect.Effect<A, unknown, AppFileSystem.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AppFileSystem.defaultLayer)))

describe("AppFileSystem pure helpers", () => {
  test("mimeType falls back to octet-stream", () => {
    expect(AppFileSystem.mimeType("x.json")).toBe("application/json")
    expect(AppFileSystem.mimeType("x.unknownext")).toBe("application/octet-stream")
  })

  test("contains and overlaps", () => {
    expect(AppFileSystem.contains("/a/b", "/a/b/c")).toBe(true)
    expect(AppFileSystem.contains("/a/b", "/a/x")).toBe(false)
    expect(AppFileSystem.overlaps("/a/b", "/a/b/c")).toBe(true)
    expect(AppFileSystem.overlaps("/a/b", "/x/y")).toBe(false)
  })

  test("resolve returns an absolute path for a missing file and the real path for a symlinked one", () => {
    expect(AppFileSystem.resolve(path.join(root, "missing", "file"))).toBe(path.join(root, "missing", "file"))
    expect(AppFileSystem.resolve(path.join(root, "a", "..", "a"))).toBe(path.join(root, "a"))
  })

  test("normalizePath and windowsPath leave posix paths alone", () => {
    if (process.platform === "win32") return
    expect(AppFileSystem.normalizePath("/x/y")).toBe("/x/y")
    expect(AppFileSystem.windowsPath("/c/Users")).toBe("/c/Users")
    expect(AppFileSystem.normalizePathPattern("/x/*")).toBe("/x/*")
  })
})

describe("AppFileSystem service", () => {
  test("isDir distinguishes directories, files and missing paths", async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        return [yield* fs.isDir(path.join(root, "a")), yield* fs.isDir(path.join(root, "marker.txt")), yield* fs.isDir(path.join(root, "nope"))]
      }),
    )
    expect(result).toEqual([true, false, false])
  })

  test("findUp collects matches from start up to the stop directory, nearest first", async () => {
    const found = await run(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        return yield* fs.findUp("marker.txt", path.join(root, "a", "b"), root)
      }),
    )
    expect(found).toEqual([path.join(root, "a", "marker.txt"), path.join(root, "marker.txt")])
  })

  test("up checks several targets per directory", async () => {
    const found = await run(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        return yield* fs.up({ targets: ["note.md", "marker.txt"], start: path.join(root, "a", "b"), stop: root })
      }),
    )
    expect(found).toEqual([path.join(root, "a", "b", "note.md"), path.join(root, "a", "marker.txt"), path.join(root, "marker.txt")])
  })

  test("globUp returns absolute matches walking upward", async () => {
    const found = await run(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        return yield* fs.globUp("*.md", path.join(root, "a", "b"), root)
      }),
    )
    expect(found).toEqual([path.join(root, "a", "b", "note.md")])
  })
})

describe("resolveHordecodeHome", () => {
  test("HORDECODE_HOME roots the four directories", () => {
    expect(resolveHordecodeHome({ HORDECODE_HOME: "/h" })).toEqual({
      mode: "hordecode_home",
      root: "/h",
      data: "/h/data",
      cache: "/h/cache",
      config: "/h/config",
      state: "/h/state",
    })
  })

  test("a relative HORDECODE_HOME is rejected", () => {
    expect(() => resolveHordecodeHome({ HORDECODE_HOME: "relative/dir" })).toThrow("must be an absolute path")
  })

  test("without HORDECODE_HOME the XDG defaults are used", () => {
    const resolved = resolveHordecodeHome({})
    expect(resolved.mode).toBe("xdg")
    expect(resolved.data.endsWith(path.join("opencode"))).toBe(true)
  })
})
