// F7: a bundled skill file that differs from the bundle is restored on extraction,
// never deleted, and named in one warning.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { extractHarnessBundle } from "../src/harness/extract"
import { extractResearchBundle } from "../src/research/extract"

function memoryFs() {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const writes: string[] = []
  let tick = 1
  let marker: string | undefined
  const fsys = {
    existsSafe: (path: string) => Effect.succeed(path === marker),
    stat: (path: string) =>
      files.has(path)
        ? Effect.succeed({
            type: "File",
            size: BigInt(Buffer.byteLength(files.get(path)!)),
            mtime: Option.some(new Date(mtimes.get(path) ?? 0)),
          })
        : Effect.fail(new Error(`missing ${path}`)),
    readFileString: (path: string) =>
      files.has(path) ? Effect.succeed(files.get(path)!) : Effect.fail(new Error(`missing ${path}`)),
    writeWithDirs: (path: string, content: string) => {
      writes.push(path)
      files.set(path, content)
      mtimes.set(path, tick++)
      if (path.includes("/.extracted-")) marker = path
      return Effect.void
    },
  }
  return { files, writes, touch: (path: string) => mtimes.set(path, tick++), fsys: fsys as never }
}

async function withStderr<T>(run: () => Promise<T>) {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const value = await run()
    return { value, stderr: chunks.join("") }
  } finally {
    process.stderr.write = original
  }
}

describe("skill bundle extraction integrity", () => {
  test("restores a modified harness skill from the bundle and names it", async () => {
    const { files, writes, touch, fsys } = memoryFs()
    await Effect.runPromise(extractHarnessBundle(fsys))

    const target = [...files.keys()].find((file) => file.endsWith("/skills/eval/SKILL.md"))!
    const bundled = files.get(target)!
    files.set(target, "tampered")
    touch(target)
    const before = writes.length

    const { stderr } = await withStderr(() => Effect.runPromise(extractHarnessBundle(fsys)))

    expect(files.get(target)).toBe(bundled)
    expect(writes.slice(before)).toEqual([target])
    expect(stderr).toContain(target)
  })

  test("restores a modified research skill from the bundle and names it", async () => {
    const { files, writes, touch, fsys } = memoryFs()
    await Effect.runPromise(extractResearchBundle(fsys))

    const target = [...files.keys()].find((file) => file.endsWith("/skills/review/SKILL.md"))!
    const bundled = files.get(target)!
    files.set(target, "tampered")
    touch(target)
    const before = writes.length

    const { stderr } = await withStderr(() => Effect.runPromise(extractResearchBundle(fsys)))

    expect(files.get(target)).toBe(bundled)
    expect(writes.slice(before)).toEqual([target])
    expect(stderr).toContain(target)
  })
})
