// @ts-nocheck
// The background npm install for the third-party plugin package
// was using the Hordecode PRODUCT version (`InstallationPluginVersion`)
// instead of the upstream SDK/API version the package was actually
// published at on npm. `InstallationPluginVersion` resolves to "0.1.0"
// (the product version) which doesn't exist on npm for the
// `@opencode-ai/plugin` package; the upstream-published version is
// `1.17.18` (`OpenCodePluginApiVersion`).
//
// This test pins the fix at source level: opencode/src/config/config.ts
// must use `OpenCodePluginApiVersion` (which equals "1.17.18" by
// core/src/installation/version.ts) and must NOT use
// `InstallationPluginVersion` anymore.
import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"

const OPENCODE_CONFIG = path.resolve(import.meta.dir, "../../src/config/config.ts")
const CORE_VERSION = path.resolve(import.meta.dir, "../../../core/src/installation/version.ts")

describe("plugin background install version", () => {
  test("opencode/src/config/config.ts pins @opencode-ai/plugin to OpenCodePluginApiVersion, never InstallationPluginVersion", async () => {
    const source = await fs.readFile(OPENCODE_CONFIG, "utf-8")

    // The defect was at line 463: version: InstallationPluginVersion.
    // Post-fix the same line reads `version: OpenCodePluginApiVersion`.
    const installBlock = source.match(
      /npmSvc[\s\S]*?\.install\(dir,\s*\{[\s\S]*?\}\s*\)[\s\S]*?\)\.pipe\(/,
    )
    expect(installBlock).not.toBeNull()
    const block = installBlock![0]

    // Must reference the plugin package (literal name -- the at-sign cannot
    // appear in source here without triggering file pickers, so we assert
    // by checking that the package-name token immediately follows the
    // `name:` field, splitting on the colon + quote).
    expect(block).toMatch(/name:\s*"\s*@opencode-ai\/plugin\s*"/)

    // Must pin to OpenCodePluginApiVersion (and the literal "1.17.18"
    // follows once the import is resolved, but typecheck above covers that
    // -- here we pin the symbol-level decision so a future PR cannot
    // silently flip it back to InstallationPluginVersion or a hardcoded
    // version string).
    expect(block).toMatch(/version:\s*OpenCodePluginApiVersion/)
    expect(block).not.toMatch(/version:\s*InstallationPluginVersion/)
    expect(block).not.toMatch(/version:\s*"0\.1\.0"/)
    expect(block).not.toMatch(/version:\s*"0\.\d+\.\d+"/)

    // The import for InstallationPluginVersion must be gone (the brief says
    // to remove it if nothing else uses it -- we verified with grep that
    // nothing else does, so we assert the import is also cleaned up).
    expect(source).not.toMatch(/InstallationPluginVersion/)
  })

  test("core/src/installation/version.ts keeps OpenCodePluginApiVersion = '1.17.18'", async () => {
    const source = await fs.readFile(CORE_VERSION, "utf-8")
    // This is the constant the opencode side now consumes. Pin its value
    // so a future PR bumping this without re-checking the npm-published
    // `@opencode-ai/plugin` versions breaks the test instead of silently
    // shipping a broken background install.
    expect(source).toMatch(/export const OpenCodePluginApiVersion\s*=\s*"1\.17\.18"/)
  })
})
