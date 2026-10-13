// Guards the package.json `bin` map against the `opencode` launcher entry
// silently returning on an upstream merge. The package must ship exactly
// two launchers: `horde` (primary) and `hordecode` (alias).
import { describe, expect, test } from "bun:test"
import pkg from "../../../package.json"

describe("package bin launcher entries", () => {
  test("ships exactly `horde` and `hordecode`, no upstream `opencode`", () => {
    const bin = pkg.bin as Record<string, string>
    const names = Object.keys(bin).sort()
    expect(names).toEqual(["horde", "hordecode"])
    expect(names).not.toContain("opencode")
    expect(bin.horde).toBe("./bin/horde")
    expect(bin.hordecode).toBe("./bin/hordecode")
  })

  test("every bin entry points at a real file on disk", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const here = path.dirname(new URL(import.meta.url).pathname)
    const pkgRoot = path.resolve(here, "../../..")
    for (const [name, target] of Object.entries(pkg.bin as Record<string, string>)) {
      const abs = path.resolve(pkgRoot, target.replace(/^\.\//, ""))
      const stat = await fs.stat(abs).catch(() => null)
      expect(stat?.isFile(), `${name} -> ${target} must exist`).toBe(true)
    }
  })
})
