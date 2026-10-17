import { describe, expect, test } from "bun:test"
import path from "path"

// Flags are read at module load, so each case runs in a fresh process.
const flagModule = path.resolve(import.meta.dir, "../src/flag/flag.ts")

function read(env: Record<string, string>, expr: string) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HORDECODE_") && !key.startsWith("OPENCODE_")),
  )
  const result = Bun.spawnSync(
    [process.execPath, "-e", `const { Flag } = await import(${JSON.stringify(flagModule)}); console.log(JSON.stringify(${expr}))`],
    { env: { ...clean, ...env } },
  )
  return JSON.parse(result.stdout.toString().trim())
}

describe("Flag twins", () => {
  test("a HORDECODE_ switch sets the OPENCODE_ flag read by upstream code", () => {
    expect(read({ HORDECODE_DISABLE_AUTOUPDATE: "1" }, "Flag.OPENCODE_DISABLE_AUTOUPDATE")).toBe(true)
    expect(read({ HORDECODE_DISABLE_MODELS_FETCH: "true" }, "Flag.OPENCODE_DISABLE_MODELS_FETCH")).toBe(true)
  })

  test("an OPENCODE_ switch still works and sets the HORDECODE_ flag", () => {
    expect(read({ OPENCODE_DISABLE_MODELS_FETCH: "1" }, "Flag.HORDECODE_DISABLE_MODELS_FETCH")).toBe(true)
    expect(read({ OPENCODE_DISABLE_AUTOUPDATE: "1" }, "Flag.OPENCODE_DISABLE_AUTOUPDATE")).toBe(true)
  })

  test("the HORDECODE_ value wins for string flags", () => {
    expect(read({ HORDECODE_CONFIG: "/a.json", OPENCODE_CONFIG: "/b.json" }, "Flag.OPENCODE_CONFIG")).toBe("/a.json")
    expect(read({ OPENCODE_CONFIG: "/b.json" }, "Flag.OPENCODE_CONFIG")).toBe("/b.json")
  })

  test("unset switches stay off", () => {
    expect(read({}, "Flag.OPENCODE_DISABLE_AUTOUPDATE")).toBe(false)
  })
})
