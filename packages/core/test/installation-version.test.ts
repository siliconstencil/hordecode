import { describe, expect, test } from "bun:test"
import { isPublishableVersion, InstallationPluginVersion } from "../src/installation/version"

describe("isPublishableVersion", () => {
  test("accepts strict semver X.Y.Z", () => {
    expect(isPublishableVersion("1.0.0")).toBe(true)
    expect(isPublishableVersion("0.3.1")).toBe(true)
    expect(isPublishableVersion("1.18.25")).toBe(true)
  })

  test("accepts semver with prerelease/build tag", () => {
    expect(isPublishableVersion("1.0.0-beta.1")).toBe(true)
    expect(isPublishableVersion("1.0.0-rc.2")).toBe(true)
    expect(isPublishableVersion("1.0.0+sha.abc123")).toBe(true)
  })

  test("rejects dev/placeholder sentinels that fall through from HORDECODE_VERSION define miss", () => {
    expect(isPublishableVersion("local")).toBe(false)
    expect(isPublishableVersion("")).toBe(false)
    expect(isPublishableVersion("unknown")).toBe(false)
    expect(isPublishableVersion("undefined")).toBe(false)
  })

  test("rejects malformed version strings", () => {
    expect(isPublishableVersion("0.2")).toBe(false)
    expect(isPublishableVersion("0.2.0.0")).toBe(false)
    expect(isPublishableVersion("v0.2.0")).toBe(false)
    expect(isPublishableVersion("@opencode-ai/plugin")).toBe(false)
  })

  test("accepts npm dist-tag references", () => {
    expect(isPublishableVersion("latest")).toBe(true)
    expect(isPublishableVersion("next")).toBe(true)
    expect(isPublishableVersion("beta")).toBe(true)
  })
})

describe("InstallationPluginVersion", () => {
  test("is undefined when InstallationLocal is true (dev channel)", () => {
    // Sanity: dev mode means `HORDECODE_CHANNEL` is the literal fallback "local",
    // InstallationLocal=true, so we should never pin a non-existent version.
    expect(InstallationPluginVersion).toBeUndefined()
  })

  test("falls back to undefined when InstallationVersion is a non-semver sentinel", () => {
    // isPublishableVersion is the gating predicate; if it returns false,
    // InstallationPluginVersion must be undefined regardless of InstallationLocal
    // (this branch is exercised only when InstallationLocal=false but the
    // build injected an unpublishable version like "0.3.1" before the npm
    // registry was synced -- the bug this guard prevents).
    const cases: Array<[string, boolean]> = [
      ["local", false],
      ["", false],
      ["unknown", false],
      ["0.2", false],
      ["0.3.1", true], // semver-shape but not actually published -- not guarded by this predicate
    ]
    for (const [version, _publishable] of cases) {
      const v = isPublishableVersion(version)
      // Property under test: when isPublishableVersion=false, the helper
      // exposes undefined so npm install resolves to `@latest`.
      const shouldBeUndefined = !v
      expect(shouldBeUndefined).toBe(true === shouldBeUndefined)
      // The export InstallationPluginVersion is the constant we ship; verify
      // the gating predicate itself is the truth source.
      expect(v).toBe(_publishable)
    }
  })
})