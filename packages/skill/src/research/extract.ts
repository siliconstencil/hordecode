import path from "path"
import { Effect } from "effect"
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

export const extractResearchBundle = Effect.fn("Skill.extractResearchBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const researchRoot = path.join(GlobalPath.data, "research", InstallationVersion)
  const marker = path.join(researchRoot, `.extracted-${BUNDLE_IDENTITY}`)

  if (yield* fsys.existsSafe(marker)) return researchRoot

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
