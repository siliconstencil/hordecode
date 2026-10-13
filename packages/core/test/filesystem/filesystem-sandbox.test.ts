// Regression: `hordecode debug file read/list` must surface a clear error
// when a path escapes the location directory (sandbox boundary is intentional,
// but the prior "Path escapes the location" message gave the user no signal
// about which path or which root rejected the request). Confirm:
//   1. lexical escape: a relative `..` resolves outside the location directory
//   2. symlink escape: a path that lexically stays inside but follows a symlink
//      to a real path outside the location root is also rejected
//   3. error message names both the offending path and the location it escaped
//
// Pattern borrowed from packages/core/test/location-filesystem.test.ts: the
// temp dir is created via withTmp and the FileSystem node is provided with
// that directory, so the test body only ever yields FileSystem.Service
// (yielding both FileSystem.Service and Location.Service in the same
// Effect.gen would collapse to a Service | Service union under Effect v4's
// self-referential Context.Service generic).
import fs from "fs/promises"
import nodeFs from "fs"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { it } from "../lib/effect"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

const die = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected defect, got success")
  const errors = Cause.prettyErrors(exit.cause)
  if (errors.length === 0) throw new Error("expected defect with message, got empty")
  return errors.join("\n")
}

describe("FileSystem.read/list sandbox", () => {
  it.live(
    "read: rejects a lexical escape with a message that names the offending path and the location",
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        // Create a file in the parent of the temp dir; this guarantees the
        // relative path needed to reach it is `..`-flavoured.
        const outside = path.dirname(directory)
        const outsideFile = path.join(outside, "p828-outside-" + Math.random().toString(36).slice(2))
        yield* Effect.promise(() => fs.writeFile(outsideFile, "should not be readable"))

        const rel = path.relative(directory, outsideFile)
        const exit = yield* service.read({ path: RelativePath.make(rel) }).pipe(Effect.exit)

        const message = die(exit)
        expect(message).toContain("escapes the location")
        expect(message).toContain(outsideFile)
        expect(message).toContain(directory)

        yield* Effect.promise(() => fs.rm(outsideFile))
      }).pipe(provide(directory)),
    ),
  )

  it.live(
    "read: rejects a symlink that resolves outside the location root, naming the resolved real path",
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        const outsideDir = path.dirname(directory)
        const outsideFile = path.join(outsideDir, "p828-symlink-target-" + Math.random().toString(36).slice(2))
        yield* Effect.promise(() => fs.writeFile(outsideFile, "should not be readable"))
        const insideLink = path.join(directory, "escape-link-" + Math.random().toString(36).slice(2))
        // Effect's FileSystem service does not expose makeSymbolicLink; use
        // host fs and let tmpdir auto-cleanup handle the rest.
        yield* Effect.promise(() => new Promise<void>((res, rej) => {
          nodeFs.symlink(outsideFile, insideLink, (err) => err ? rej(err) : res())
        }))

        const exit = yield* service.read({ path: RelativePath.make(path.basename(insideLink)) }).pipe(Effect.exit)

        const message = die(exit)
        expect(message).toContain("symlink")
        expect(message).toContain(outsideFile)

        yield* Effect.promise(() => fs.rm(outsideFile))
      }).pipe(provide(directory)),
    ),
  )

  it.live(
    "list: rejects a lexical escape with a message that names the offending path",
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        const exit = yield* service.list({ path: RelativePath.make("..") }).pipe(Effect.exit)
        const message = die(exit)
        expect(message).toContain("escapes the location")
        expect(message).toContain(path.dirname(directory))
      }).pipe(provide(directory)),
    ),
  )

  it.live(
    "read: a path that resolves inside the location succeeds (negative control)",
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        const file = path.join(directory, "p828-inside.txt")
        yield* Effect.promise(() => fs.writeFile(file, "ok"))
        const result = yield* service.read({ path: RelativePath.make("p828-inside.txt") })
        expect(Buffer.from(result.content).toString("utf8")).toBe("ok")
        yield* Effect.promise(() => fs.rm(file))
      }).pipe(provide(directory)),
    ),
  )
})
