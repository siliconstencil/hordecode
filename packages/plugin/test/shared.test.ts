import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { pathToFileURL } from "url"

import {
  checkPluginCompatibility,
  createPluginEntry,
  isDeprecatedPlugin,
  isPathPluginSpec,
  parsePluginSpecifier,
  pluginSource,
  readPackageThemes,
  readPluginId,
  readPluginPackage,
  readV1Plugin,
  resolvePathPluginTarget,
  resolvePluginId,
} from "../src/shared"

let dirs: string[] = []

async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "plugin-shared-"))
  dirs.push(dir)
  return dir
}

async function writeJson(file: string, data: unknown) {
  await writeFile(file, JSON.stringify(data, null, 2))
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

describe("parsePluginSpecifier", () => {
  test("bare package name resolves to latest", () => {
    expect(parsePluginSpecifier("my-plugin")).toEqual({ pkg: "my-plugin", version: "latest" })
  })

  test("scoped package with version", () => {
    expect(parsePluginSpecifier("@scope/plugin@^1.2.0")).toEqual({ pkg: "@scope/plugin", version: "^1.2.0" })
  })

  test("alias specifier with a name keeps the alias name and raw spec", () => {
    expect(parsePluginSpecifier("my-alias@npm:@scope/plugin@1.0.0")).toEqual({
      pkg: "my-alias",
      version: "npm:@scope/plugin@1.0.0",
    })
  })

  test("unparseable specifier falls back to the raw spec", () => {
    expect(parsePluginSpecifier("alias:npm:@scope/plugin@1.0.0")).toEqual({
      pkg: "alias:npm:@scope/plugin@1.0.0",
      version: "",
    })
  })

  test("package at tag", () => {
    expect(parsePluginSpecifier("my-plugin@beta")).toEqual({ pkg: "my-plugin", version: "beta" })
  })
})

describe("isPathPluginSpec / pluginSource", () => {
  test("file URL is a path plugin", () => {
    expect(isPathPluginSpec("file:///tmp/x")).toBe(true)
    expect(pluginSource("file:///tmp/x")).toBe("file")
  })

  test("relative path is a path plugin", () => {
    expect(isPathPluginSpec("./plugin-dir")).toBe(true)
    expect(pluginSource("./plugin-dir")).toBe("file")
  })

  test("absolute path is a path plugin", () => {
    expect(isPathPluginSpec("/tmp/plugin-dir")).toBe(true)
    expect(pluginSource("/tmp/plugin-dir")).toBe("file")
  })

  test("windows-style absolute path is a path plugin", () => {
    expect(isPathPluginSpec("C:\\plugin\\dir")).toBe(true)
  })

  test("bare package name is an npm plugin", () => {
    expect(isPathPluginSpec("my-plugin")).toBe(false)
    expect(pluginSource("my-plugin")).toBe("npm")
  })

  test("scoped package is an npm plugin", () => {
    expect(isPathPluginSpec("@scope/plugin")).toBe(false)
    expect(pluginSource("@scope/plugin")).toBe("npm")
  })
})

describe("isDeprecatedPlugin", () => {
  test("detects deprecated built-in packages", () => {
    expect(isDeprecatedPlugin("opencode-openai-codex-auth")).toBe(true)
    expect(isDeprecatedPlugin("opencode-copilot-auth")).toBe(true)
  })

  test("does not flag unrelated packages", () => {
    expect(isDeprecatedPlugin("my-plugin")).toBe(false)
  })
})

describe("readPluginPackage", () => {
  test("reads package.json from a directory target", async () => {
    const dir = await tmp()
    const json = { name: "test-plugin", version: "1.0.0" }
    await writeJson(path.join(dir, "package.json"), json)
    const pkg = await readPluginPackage(dir)
    expect(pkg).toEqual({ dir, pkg: path.join(dir, "package.json"), json })
  })

  test("reads package.json from a file target via its directory", async () => {
    const dir = await tmp()
    const json = { name: "file-plugin" }
    await writeJson(path.join(dir, "package.json"), json)
    const file = path.join(dir, "index.ts")
    await writeFile(file, "export default {}")
    const pkg = await readPluginPackage(file)
    expect(pkg.dir).toBe(dir)
    expect(pkg.json).toEqual(json)
  })

  test("reads package.json from a file:// target", async () => {
    const dir = await tmp()
    const json = { name: "url-plugin" }
    await writeJson(path.join(dir, "package.json"), json)
    const pkg = await readPluginPackage(pathToFileURL(dir).href)
    expect(pkg.json).toEqual(json)
  })
})

describe("resolvePathPluginTarget", () => {
  test("resolves a directory with package.json to its file URL", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "x" })
    expect(await resolvePathPluginTarget(dir)).toBe(pathToFileURL(dir).href)
  })

  test("resolves a directory with index file to the index file URL", async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, "index.ts"), "export default {}")
    expect(await resolvePathPluginTarget(dir)).toBe(pathToFileURL(path.join(dir, "index.ts")).href)
  })

  test("throws when directory has neither package.json nor index file", async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, "readme.md"), "no entry")
    await expect(resolvePathPluginTarget(dir)).rejects.toThrow(
      `Plugin directory ${dir} is missing package.json or index file`,
    )
  })

  test("resolves a plain file path to its file URL", async () => {
    const dir = await tmp()
    const file = path.join(dir, "plugin.ts")
    await writeFile(file, "export default {}")
    expect(await resolvePathPluginTarget(file)).toBe(pathToFileURL(file).href)
  })

  test("file:// spec of a plain file is preserved", async () => {
    const dir = await tmp()
    const file = path.join(dir, "plugin.ts")
    await writeFile(file, "export default {}")
    expect(await resolvePathPluginTarget(pathToFileURL(file).href)).toBe(pathToFileURL(file).href)
  })

  test("resolves a relative spec against cwd", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "rel" })
    const rel = path.relative(process.cwd(), dir)
    expect(await resolvePathPluginTarget(rel)).toBe(pathToFileURL(dir).href)
  })
})

describe("createPluginEntry", () => {
  test("file plugin directory without exports keeps the directory as entry", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "file-plugin" })
    await writeFile(path.join(dir, "index.ts"), "export default {}")
    const entry = await createPluginEntry(dir, dir, "server")
    expect(entry.spec).toBe(dir)
    expect(entry.source).toBe("file")
    expect(entry.target).toBe(dir)
    expect(entry.pkg?.json.name).toBe("file-plugin")
    expect(entry.entry).toBe(dir)
  })

  test("file plugin directory with exports resolves the index entry", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "file-plugin", exports: {} })
    await writeFile(path.join(dir, "index.ts"), "export default {}")
    const entry = await createPluginEntry(dir, dir, "server")
    expect(entry.entry).toBe(pathToFileURL(path.join(dir, "index.ts")).href)
  })

  test("npm plugin package with exports ./server resolves the server entry", async () => {
    const dir = await tmp()
    const json = {
      name: "npm-plugin",
      exports: {
        "./server": "./server.js",
        "./tui": "./tui.js",
      },
    }
    await writeJson(path.join(dir, "package.json"), json)
    await writeFile(path.join(dir, "server.js"), "module.exports = {}")
    await writeFile(path.join(dir, "tui.js"), "module.exports = {}")
    const entry = await createPluginEntry("npm-plugin", dir, "server")
    expect(entry.source).toBe("npm")
    expect(entry.entry).toBe(pathToFileURL(path.join(dir, "server.js")).href)
  })

  test("npm plugin without exports falls back to main for server", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "main-plugin", main: "./dist/index.js" })
    await mkdir(path.join(dir, "dist"), { recursive: true })
    await writeFile(path.join(dir, "dist", "index.js"), "module.exports = {}")
    const entry = await createPluginEntry("main-plugin", dir, "server")
    expect(entry.entry).toBe(pathToFileURL(path.join(dir, "dist", "index.js")).href)
  })

  test("npm plugin without server entry leaves entry undefined", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "tui-only", exports: { "./tui": "./tui.js" } })
    await writeFile(path.join(dir, "tui.js"), "module.exports = {}")
    const entry = await createPluginEntry("tui-only", dir, "server")
    expect(entry.entry).toBeUndefined()
  })

  test("rejects entry that escapes the plugin directory", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), {
      name: "evil-plugin",
      exports: { "./server": "../../outside.js" },
    })
    await expect(createPluginEntry("evil-plugin", dir, "server")).rejects.toThrow(
      `Plugin evil-plugin resolved server entry outside plugin directory`,
    )
  })
})

describe("checkPluginCompatibility", () => {
  test("throws when opencode version does not satisfy engines.opencode", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "old", engines: { opencode: "^1.0.0" } })
    await expect(checkPluginCompatibility(dir, "2.5.0")).rejects.toThrow(
      `Plugin requires opencode ^1.0.0 but running 2.5.0`,
    )
  })

  test("passes when version satisfies engines.opencode", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "ok", engines: { opencode: "^2.0.0" } })
    await expect(checkPluginCompatibility(dir, "2.5.0")).resolves.toBeUndefined()
  })

  test("skips check when running a 0.x opencode version", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "dev", engines: { opencode: "^1.0.0" } })
    await expect(checkPluginCompatibility(dir, "0.4.0")).resolves.toBeUndefined()
  })

  test("skips check when engines.opencode is absent", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "noeng", engines: { node: ">=18" } })
    await expect(checkPluginCompatibility(dir, "2.5.0")).resolves.toBeUndefined()
  })

  test("skips check when package.json is missing", async () => {
    const dir = await tmp()
    await expect(checkPluginCompatibility(dir, "2.5.0")).resolves.toBeUndefined()
  })
})

describe("readV1Plugin", () => {
  test("accepts a valid server plugin", () => {
    const mod = { default: { id: "p", server: () => {} } }
    expect(readV1Plugin(mod, "p", "server")).toEqual({ id: "p", server: expect.any(Function) })
  })

  test("accepts a valid tui plugin", () => {
    const mod = { default: { id: "p", tui: () => {} } }
    expect(readV1Plugin(mod, "p", "tui")).toEqual({ id: "p", tui: expect.any(Function) })
  })

  test("throws when default export is not an object", () => {
    expect(() => readV1Plugin({ default: 42 }, "p", "server")).toThrow(
      `Plugin p must default export an object with server()`,
    )
  })

  test("throws when server export is not a function", () => {
    const mod = { default: { id: "p", server: "nope" } }
    expect(() => readV1Plugin(mod, "p", "server")).toThrow(`Plugin p has invalid server export`)
  })

  test("throws when both server and tui are exported", () => {
    const mod = { default: { id: "p", server: () => {}, tui: () => {} } }
    expect(() => readV1Plugin(mod, "p", "server")).toThrow(
      `Plugin p must default export either server() or tui(), not both`,
    )
  })

  test("throws when kind is server but only tui is exported", () => {
    const mod = { default: { id: "p", tui: () => {} } }
    expect(() => readV1Plugin(mod, "p", "server")).toThrow(
      `Plugin p must default export an object with server()`,
    )
  })

  test("detect mode returns undefined for an empty module", () => {
    expect(readV1Plugin({ default: {} }, "p", "server", "detect")).toBeUndefined()
  })
})

describe("readPluginId", () => {
  test("returns trimmed id", () => {
    expect(readPluginId("  my-plugin  ", "p")).toBe("my-plugin")
  })

  test("returns undefined for missing id", () => {
    expect(readPluginId(undefined, "p")).toBeUndefined()
  })

  test("throws for non-string id", () => {
    expect(() => readPluginId(42, "p")).toThrow(`Plugin p has invalid id type number`)
  })

  test("throws for empty id", () => {
    expect(() => readPluginId("   ", "p")).toThrow(`Plugin p has an empty id`)
  })
})

describe("resolvePluginId", () => {
  test("file plugin with explicit id returns it", async () => {
    expect(await resolvePluginId("file", "./x", "/tmp/x", "my-id")).toBe("my-id")
  })

  test("file plugin without id throws", async () => {
    await expect(resolvePluginId("file", "./x", "/tmp/x", undefined)).rejects.toThrow(
      `Path plugin ./x must export id`,
    )
  })

  test("npm plugin falls back to package.json name", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "npm-plugin" })
    expect(await resolvePluginId("npm", "npm-plugin", dir, undefined)).toBe("npm-plugin")
  })

  test("npm plugin with explicit id wins over package name", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), { name: "npm-plugin" })
    expect(await resolvePluginId("npm", "npm-plugin", dir, "custom-id")).toBe("custom-id")
  })

  test("npm plugin without name throws", async () => {
    const dir = await tmp()
    await writeJson(path.join(dir, "package.json"), {})
    await expect(resolvePluginId("npm", "npm-plugin", dir, undefined)).rejects.toThrow(
      `Plugin package ${path.join(dir, "package.json")} is missing name`,
    )
  })
})

describe("readPackageThemes", () => {
  test("returns empty array when oc-themes is absent", async () => {
    const dir = await tmp()
    const pkg = { dir, pkg: path.join(dir, "package.json"), json: { name: "x" } }
    expect(readPackageThemes("x", pkg)).toEqual([])
  })

  test("resolves relative theme paths and dedupes", async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, "a.json"), "{}")
    await writeFile(path.join(dir, "b.json"), "{}")
    const pkg = { dir, pkg: path.join(dir, "package.json"), json: { "oc-themes": ["./a.json", "./a.json", "./b.json"] } }
    expect(readPackageThemes("x", pkg)).toEqual([path.join(dir, "a.json"), path.join(dir, "b.json")])
  })

  test("throws for a non-array oc-themes field", async () => {
    const dir = await tmp()
    const pkg = { dir, pkg: path.join(dir, "package.json"), json: { "oc-themes": "red" } }
    expect(() => readPackageThemes("x", pkg)).toThrow(`Plugin x has invalid oc-themes field`)
  })

  test("throws for an absolute theme path", async () => {
    const dir = await tmp()
    const pkg = { dir, pkg: path.join(dir, "package.json"), json: { "oc-themes": ["/etc/passwd"] } }
    expect(() => readPackageThemes("x", pkg)).toThrow(`Plugin x oc-themes entry must be relative: /etc/passwd`)
  })

  test("throws for an empty theme entry", async () => {
    const dir = await tmp()
    const pkg = { dir, pkg: path.join(dir, "package.json"), json: { "oc-themes": ["   "] } }
    expect(() => readPackageThemes("x", pkg)).toThrow(`Plugin x has empty oc-themes entry`)
  })
})
