import path from "path"
import { Effect, Option } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Path as GlobalPath } from "@opencode-ai/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Hash } from "@opencode-ai/core/util/hash"
import { Log } from "@opencode-ai/core/util"
import { loadResearchBundle } from "./bundle.macro" with { type: "macro" }
import { loadResearchBundle as loadResearchBundleDev } from "./bundle.macro"

function safeLoadResearchBundle() {
  try {
    return loadResearchBundle()
  } catch (e) {
    if (e instanceof ReferenceError) {
      return loadResearchBundleDev()
    }
    throw e
  }
}
const RESEARCH_BUNDLE = safeLoadResearchBundle()

const log = Log.create({ service: "skill.research" })

// Content hash of the bundle written below. The marker includes it so dev/test/
// local builds (InstallationLocal, which used to skip the marker entirely)
// extract once per data root instead of once per Skill layer build, and still
// re-extract when the embedded bundle changes.
const BUNDLE_IDENTITY = Hash.sha256(
  JSON.stringify(
    Object.entries(RESEARCH_BUNDLE)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([skillName, files]) => [
        skillName,
        Object.keys(files)
          .sort()
          .map((relPath) => [relPath, files[relPath]]),
      ]),
  ),
).slice(0, 16)

// F7: the write lock stops an in-place edit, but a file changed before the lock
// existed (or through a path the lock cannot see) must not survive a restart.
// A file untouched since extraction is left alone; one modified after it is read
// and, if its content differs, restored and named in one warning. Comparing
// content only for newer files keeps every cached Skill layer build cheap.
const verified = new Set<string>()

const restoreResearchBundle = Effect.fn("Skill.restoreResearchBundle")(function* (
  fsys: AppFileSystem.Interface,
  researchRoot: string,
  markerTime: number | undefined,
) {
  yield* Effect.forEach(
    Object.entries(RESEARCH_BUNDLE),
    ([skillName, files]) =>
      Effect.forEach(
        Object.entries(files),
        ([relPath, content]) =>
          Effect.gen(function* () {
            const file = path.join(researchRoot, "skills", skillName, relPath)
            const info = yield* fsys.stat(file).pipe(Effect.orElseSucceed(() => undefined))
            const mtime = info && Option.getOrUndefined(info.mtime)
            if (mtime && markerTime !== undefined && mtime.getTime() <= markerTime) return
            const current = yield* fsys.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
            if (current === content) return
            yield* fsys.writeWithDirs(file, content)
            log.warn("restored installed skill from bundle", { file })
          }),
        { concurrency: 16, discard: true },
      ),
    { concurrency: 4, discard: true },
  )
})

export const extractResearchBundle = Effect.fn("Skill.extractResearchBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const researchRoot = path.join(GlobalPath.data, "research", InstallationVersion)
  const marker = path.join(researchRoot, `.extracted-${BUNDLE_IDENTITY}`)

  // F7: verify a pre-existing tree once per marker inode per process. A fresh
  // extraction just wrote every file from the bundle, and later instances skip
  // the scan. A stub filesystem without an inode is always verified.
  if (yield* fsys.existsSafe(marker)) {
    const info = yield* fsys.stat(marker).pipe(Effect.orElseSucceed(() => undefined))
    const ino = info?.ino ? Option.getOrUndefined(info.ino) : undefined
    const key = info && ino !== undefined ? `${marker}:${info.dev}:${ino}` : undefined
    if (!key || !verified.has(key)) {
      yield* restoreResearchBundle(fsys, researchRoot, info && Option.getOrUndefined(info.mtime)?.getTime())
      if (key) verified.add(key)
    }
    return researchRoot
  }

  yield* Effect.forEach(
    Object.entries(RESEARCH_BUNDLE),
    ([skillName, files]) =>
      Effect.forEach(
        Object.entries(files),
        ([relPath, content]) => fsys.writeWithDirs(path.join(researchRoot, "skills", skillName, relPath), content),
        { concurrency: 16, discard: true },
      ),
    { concurrency: 4, discard: true },
  )
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted research skills", { researchRoot })
  return researchRoot
})
