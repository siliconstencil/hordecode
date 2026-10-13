import { describe, expect, spyOn, test } from "bun:test"
import { Npm } from "@opencode-ai/core/npm"
import { parsePluginSpecifier, resolvePluginTarget } from "../../src/plugin/shared"

describe("parsePluginSpecifier", () => {
  test("parses standard npm package without version", () => {
    expect(parsePluginSpecifier("acme")).toEqual({
      pkg: "acme",
      version: "latest",
    })
  })

  test("parses standard npm package with version", () => {
    expect(parsePluginSpecifier("acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "1.0.0",
    })
  })

  test("parses scoped npm package without version", () => {
    expect(parsePluginSpecifier("@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })

  test("parses scoped npm package with version", () => {
    expect(parsePluginSpecifier("@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses package with git+https url", () => {
    expect(parsePluginSpecifier("acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+https url", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses unaliased git+ssh url", () => {
    expect(parsePluginSpecifier("git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "git+ssh://git@github.com/opencode/acme.git",
      version: "",
    })
  })

  test("parses npm alias using the alias name", () => {
    expect(parsePluginSpecifier("acme@npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "npm:@opencode/acme@1.0.0",
    })
  })

  test("parses bare npm protocol specifier using the target package", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses unversioned npm protocol specifier", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })
})

describe("resolvePluginTarget", () => {
  test("resolves a bare npm name to `${name}@latest` (upstream contract)", async () => {
    // Spy on Npm.add and assert a bare spec gets the `@latest` suffix
    // appended, matching the upstream behavior. A later change made this throw
    // ("no pinned version") which broke every existing OpenCode user's
    // `opencode.json` declaring a plugin by bare name -- the upstream-compat
    // invariant violation that was reverted.
    const add = spyOn(Npm, "add").mockImplementation(async (spec) => ({
      directory: `/tmp/resolve/${spec}`,
      entrypoint: undefined,
    }))
    try {
      await resolvePluginTarget("acme")
      await resolvePluginTarget("@scope/foo")
      expect(add.mock.calls.map((c) => c[0])).toEqual(["acme@latest", "@scope/foo@latest"])
    } finally {
      add.mockRestore()
    }
  })

  test("passes a versioned spec through to Npm.add unchanged", async () => {
    const add = spyOn(Npm, "add").mockImplementation(async (spec) => ({
      directory: `/tmp/resolve/${spec}`,
      entrypoint: undefined,
    }))
    try {
      await resolvePluginTarget("acme@1.2.3")
      expect(add.mock.calls.map((c) => c[0])).toEqual(["acme@1.2.3"])
    } finally {
      add.mockRestore()
    }
  })
})
