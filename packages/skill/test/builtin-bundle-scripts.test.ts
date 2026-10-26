import { describe, expect, test } from "bun:test"
import { loadBuiltinBundle } from "../src/builtin/bundle.macro"

describe("builtin skill bundle", () => {
  const bundle = loadBuiltinBundle()

  test("every scripts/ path a SKILL.md names ships in its bundle", () => {
    const missing: string[] = []
    for (const [name, files] of Object.entries(bundle)) {
      const skill = files["SKILL.md"]
      if (!skill) continue
      for (const ref of new Set(skill.match(/scripts\/\w[\w.-]*/g) ?? [])) {
        const shipped = Object.keys(files).some((file) => file === ref || file.startsWith(`${ref}/`))
        if (!shipped) missing.push(`${name}: ${ref}`)
      }
    }
    expect(missing).toEqual([])
  })

  test("drive-hordecode ships wait-for-text.sh", () => {
    expect(bundle["drive-hordecode"]?.["scripts/wait-for-text.sh"]).toStartWith("#!/usr/bin/env bash")
  })
})
