import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { Hash } from "../src/util/hash"
import { Module } from "../src/util/module"
import { fn } from "../src/util/fn"
import { lazy } from "../src/util/lazy"
import { Glob } from "../src/util/glob"
import { getDirectory, getFileExtension, getFilename, getFilenameTruncated, truncateMiddle } from "../src/util/path"
import { Identifier } from "../src/util/identifier"
import { base64Decode, base64Encode, checksum, hash, sampledChecksum } from "../src/util/encode"
import { NamedError } from "../src/util/error"
import { Slug } from "../src/util/slug"

describe("Hash", () => {
  test("fast is a stable sha1 hex digest", () => {
    expect(Hash.fast("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d")
    expect(Hash.fast(Buffer.from("abc"))).toBe(Hash.fast("abc"))
  })
})

describe("Module.resolve", () => {
  test("resolves an installed package from a directory and returns undefined for a missing one", () => {
    expect(Module.resolve("zod", import.meta.dir)).toContain("zod")
    expect(Module.resolve("definitely-not-a-package-xyz", import.meta.dir)).toBeUndefined()
  })
})

describe("fn", () => {
  const add = fn(z.object({ a: z.number() }), (input) => input.a + 1)

  test("validates input before calling", () => {
    expect(add({ a: 1 })).toBe(2)
    expect(() => add({ a: "x" as unknown as number })).toThrow()
  })

  test("force skips validation and schema is exposed", () => {
    expect(add.force({ a: "x" as unknown as number }) as unknown).toBe("x1")
    expect(add.schema).toBeDefined()
  })
})

describe("lazy", () => {
  test("runs the factory once, including when it returns a falsy value", () => {
    let calls = 0
    const value = lazy(() => {
      calls++
      return 0
    })
    expect(value()).toBe(0)
    expect(value()).toBe(0)
    expect(calls).toBe(1)
  })
})

describe("Glob.match", () => {
  test("matches including dotfiles", () => {
    expect(Glob.match("src/**/*.ts", "src/a/b.ts")).toBe(true)
    expect(Glob.match("*.ts", "a.js")).toBe(false)
    expect(Glob.match("**/*.json", ".hordecode/config.json")).toBe(true)
  })
})

describe("path helpers", () => {
  test("getFilename and getDirectory handle trailing separators and empty input", () => {
    expect(getFilename("/a/b/c.txt")).toBe("c.txt")
    expect(getFilename("/a/b/")).toBe("b")
    expect(getFilename(undefined)).toBe("")
    expect(getDirectory("/a/b/c.txt")).toBe("/a/b/")
    expect(getDirectory("")).toBe("")
  })

  test("getFileExtension returns the last segment", () => {
    expect(getFileExtension("a/b.tar.gz")).toBe("gz")
    expect(getFileExtension(undefined)).toBe("")
  })

  test("getFilenameTruncated keeps the extension", () => {
    expect(getFilenameTruncated("/x/short.ts")).toBe("short.ts")
    expect(getFilenameTruncated("/x/a-very-long-file-name.ts", 12)).toBe("a-very-l\u2026.ts")
  })

  test("truncateMiddle keeps both ends", () => {
    expect(truncateMiddle("abcdef", 10)).toBe("abcdef")
    expect(truncateMiddle("abcdefghij", 6)).toBe("abc\u2026ij")
  })
})

describe("Identifier", () => {
  test("ascending ids sort in creation order and have a fixed length", () => {
    const ids = Array.from({ length: 50 }, () => Identifier.ascending())
    expect(ids.every((id) => id.length === 26)).toBe(true)
    expect([...ids].sort()).toEqual(ids)
  })

  test("descending ids sort in reverse creation order", () => {
    const ids = Array.from({ length: 20 }, (_, i) => Identifier.create(true, 1_000_000 + i))
    expect([...ids].sort().reverse()).toEqual(ids)
  })
})

describe("encode", () => {
  test("base64 round-trips unicode and is url safe", () => {
    const text = "h\u00e9llo \u4e16\u754c / ? + ="
    const encoded = base64Encode(text)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64Decode(encoded)).toBe(text)
  })

  test("hash is a hex SHA-256 digest", async () => {
    expect(await hash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("checksum is stable, changes with content and is undefined for empty input", () => {
    expect(checksum("")).toBeUndefined()
    expect(checksum("abc")).toBe(checksum("abc"))
    expect(checksum("abc")).not.toBe(checksum("abd"))
  })

  test("sampledChecksum equals checksum under the limit and samples above it", () => {
    expect(sampledChecksum("abc")).toBe(checksum("abc"))
    expect(sampledChecksum("")).toBeUndefined()
    const big = "x".repeat(600_000)
    expect(sampledChecksum(big)).toStartWith("600000:")
    expect(sampledChecksum(big)).not.toBe(sampledChecksum(big + "y"))
  })
})

describe("NamedError", () => {
  const Boom = NamedError.create("BoomError", z.object({ code: z.number() }))

  test("carries its name and data and serializes them", () => {
    const error = new Boom({ code: 7 })
    expect(error.name).toBe("BoomError")
    expect(error.toObject()).toEqual({ name: "BoomError", data: { code: 7 } })
    expect(Boom.isInstance(error)).toBe(true)
    expect(Boom.isInstance({ name: "Other" })).toBe(false)
  })

  test("hasName checks any error-like value and Unknown is predefined", () => {
    expect(NamedError.hasName(new Boom({ code: 1 }), "BoomError")).toBe(true)
    expect(NamedError.hasName("nope", "BoomError")).toBe(false)
    expect(new NamedError.Unknown({ message: "x" }).toObject().name).toBe("UnknownError")
  })
})

describe("Slug.create", () => {
  test("is adjective-noun", () => {
    expect(Slug.create()).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
