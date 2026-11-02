import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Path as GlobalPath } from "@opencode-ai/global"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
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

export const extractResearchBundle = Effect.fn("Skill.extractResearchBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const researchRoot = path.join(GlobalPath.data, "research", InstallationVersion)
  const marker = path.join(researchRoot, ".extracted")

  if (!InstallationLocal && (yield* fsys.existsSafe(marker))) return researchRoot

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
