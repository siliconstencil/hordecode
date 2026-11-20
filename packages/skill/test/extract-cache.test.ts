import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { extractBuiltinBundle } from "../src/builtin/extract"
import { extractHarnessBundle } from "../src/harness/extract"
import { extractResearchBundle } from "../src/research/extract"

// Dev/test builds have InstallationLocal true, so the extractors used to ignore
// the on-disk marker and rewrite every bundle entry on each Skill layer build.
// Each opencode test creates its own Skill layer (per test instance), so the same
// ~280 files were rewritten per test; under a full-suite load that is the 6 s cost
// the skill tests were timing out on. The marker now carries the bundle content
// hash and is honored in local builds too, so a second instance writing the same
// data root extracts nothing, while a bundle (or flag) change re-extracts.
function countingFs() {
  const writes: string[] = []
  // F7: content map so the integrity scan can verify files without touching disk.
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
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
  return { writes, fsys: fsys as never }
}

describe("skill bundle extraction markers", () => {
  test("extracts the builtin bundle once per data root", async () => {
    const { writes, fsys } = countingFs()
    await Effect.runPromise(extractBuiltinBundle(fsys))
    const first = writes.length
    expect(first).toBeGreaterThan(0)
    await Effect.runPromise(extractBuiltinBundle(fsys))
    expect(writes.length).toBe(first)
  })

  test("extracts the harness bundle once per data root", async () => {
    const { writes, fsys } = countingFs()
    await Effect.runPromise(extractHarnessBundle(fsys))
    const first = writes.length
    expect(first).toBeGreaterThan(0)
    await Effect.runPromise(extractHarnessBundle(fsys))
    expect(writes.length).toBe(first)
  })

  test("extracts the research bundle once per data root", async () => {
    const { writes, fsys } = countingFs()
    await Effect.runPromise(extractResearchBundle(fsys))
    const first = writes.length
    expect(first).toBeGreaterThan(0)
    await Effect.runPromise(extractResearchBundle(fsys))
    expect(writes.length).toBe(first)
  })
})
