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

  for (const [skillName, files] of Object.entries(RESEARCH_BUNDLE)) {
    const dir = path.join(researchRoot, "skills", skillName)
    for (const [relPath, content] of Object.entries(files)) {
      // Scripts are run by path, so they need the execute bit.
      yield* fsys.writeWithDirs(path.join(dir, relPath), content, relPath.endsWith(".sh") ? 0o755 : undefined)
    }
  }
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted research skills", { researchRoot })
  return researchRoot
})
