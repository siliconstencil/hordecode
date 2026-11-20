import path from "path"
import { pathToFileURL } from "url"
import { Effect, Option } from "effect"
import matter from "gray-matter"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Path as GlobalPath } from "@opencode-ai/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Hash } from "@opencode-ai/core/util/hash"
import { Log } from "@opencode-ai/core/util"
import { loadHarnessBundle } from "./bundle.macro" with { type: "macro" }
import { loadHarnessBundle as loadHarnessBundleDev } from "./bundle.macro"
import { loadResearchBundle } from "../research/bundle.macro" with { type: "macro" }
import { loadResearchBundle as loadResearchBundleDev } from "../research/bundle.macro"
import { fallbackSanitization } from "@opencode-ai/core/config/markdown"

/// Bun macros only resolve in the static import graph of an entry point.
/// In dynamic import() chains (e.g. plugin tests), the macro is unavailable --
/// fall back to a normal runtime import of the same function.
/// `typeof loadHarnessBundle` is always "undefined" even after macro expansion
/// (Bun replaces the call site, not the binding), so use try/catch instead.
function safeLoadHarnessBundle() {
  try {
    return loadHarnessBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadHarnessBundleDev()
    }
    throw e
  }
}
const HARNESS_BUNDLE = safeLoadHarnessBundle()

function safeLoadResearchBundle() {
  try {
    return loadResearchBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadResearchBundleDev()
    }
    throw e
  }
}
const RESEARCH_BUNDLE = safeLoadResearchBundle()

const BUNDLES: Record<string, Record<string, Record<string, string>>> = {
  harness: HARNESS_BUNDLE,
  research: RESEARCH_BUNDLE,
}

const log = Log.create({ service: "skill.harness" })

// Content hash of the bundle written below. The marker includes it so dev/test/
// local builds (InstallationLocal, which used to skip the marker entirely)
// extract once per data root instead of once per Skill layer build, and still
// re-extract when the embedded bundle changes.
const BUNDLE_IDENTITY = Hash.sha256(
  JSON.stringify(
    Object.entries(HARNESS_BUNDLE)
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

const restoreHarnessBundle = Effect.fn("Skill.restoreHarnessBundle")(function* (
  fsys: AppFileSystem.Interface,
  harnessRoot: string,
  markerTime: number | undefined,
) {
  yield* Effect.forEach(
    Object.entries(HARNESS_BUNDLE),
    ([skillName, files]) =>
      Effect.forEach(
        Object.entries(files),
        ([relPath, content]) =>
          Effect.gen(function* () {
            const file = path.join(harnessRoot, "skills", skillName, relPath)
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

export const extractHarnessBundle = Effect.fn("Skill.extractHarnessBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const harnessRoot = path.join(GlobalPath.data, "harness", InstallationVersion)
  const marker = path.join(harnessRoot, `.extracted-${BUNDLE_IDENTITY}`)

  // F7: verify a pre-existing tree once per marker inode per process. A fresh
  // extraction just wrote every file from the bundle, and later instances skip
  // the scan. A stub filesystem without an inode is always verified.
  if (yield* fsys.existsSafe(marker)) {
    const info = yield* fsys.stat(marker).pipe(Effect.orElseSucceed(() => undefined))
    const ino = info?.ino ? Option.getOrUndefined(info.ino) : undefined
    const key = info && ino !== undefined ? `${marker}:${info.dev}:${ino}` : undefined
    if (!key || !verified.has(key)) {
      yield* restoreHarnessBundle(fsys, harnessRoot, info && Option.getOrUndefined(info.mtime)?.getTime())
      if (key) verified.add(key)
    }
    return harnessRoot
  }

  yield* Effect.forEach(
    Object.entries(HARNESS_BUNDLE),
    ([skillName, files]) =>
      Effect.forEach(
        Object.entries(files),
        ([relPath, content]) => fsys.writeWithDirs(path.join(harnessRoot, "skills", skillName, relPath), content),
        { concurrency: 16, discard: true },
      ),
    { concurrency: 4, discard: true },
  )
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted harness skills", { harnessRoot })
  return harnessRoot
})


function parseSkillMeta(content: string) {
  try {
    return matter(content)
  } catch {
    try {
      return matter(fallbackSanitization(content))
    } catch {
      return undefined
    }
  }
}

export function harnessSkillsBlock(): string {
  const harnessRoot = path.join(GlobalPath.data, "harness", InstallationVersion)
  const entries: string[] = []

  for (const [skillName, files] of Object.entries(HARNESS_BUNDLE)) {
    const skillMd = files["SKILL.md"]
    if (!skillMd) continue
    const parsed = parseSkillMeta(skillMd)
    if (!parsed?.data?.name || !parsed?.data?.description) continue

    const displayName = (parsed.data.name as string)
    const location = pathToFileURL(path.join(harnessRoot, "skills", skillName, "SKILL.md")).href
    entries.push(
      `  <skill>`,
      `    <name>${displayName}</name>`,
      `    <description>${parsed.data.description}</description>`,
      `    <location>${location}</location>`,
      `  </skill>`,
    )
  }

  if (entries.length === 0) return ""
  return ["<available_skills>", ...entries, "</available_skills>"].join("\n")
}


function skillsBlockForBundle(
  bundle: Record<string, Record<string, string>>,
  root: string,
): string {
  const entries: string[] = []
  for (const [skillName, files] of Object.entries(bundle)) {
    const skillMd = files["SKILL.md"]
    if (!skillMd) continue
    const parsed = parseSkillMeta(skillMd)
    if (!parsed?.data?.name || !parsed?.data?.description) continue
    const location = pathToFileURL(path.join(root, "skills", skillName, "SKILL.md")).href
    entries.push(
      `  <skill>`,
      `    <name>${parsed.data.name}</name>`,
      `    <description>${parsed.data.description}</description>`,
      `    <location>${location}</location>`,
      `  </skill>`,
    )
  }
  if (entries.length === 0) return ""
  return ["<available_skills>", ...entries, "</available_skills>"].join("\n")
}

export function modeSkillsBlock(mode: string): string {
  const bundle = BUNDLES[mode]
  if (!bundle) return ""
  const root = path.join(GlobalPath.data, mode, InstallationVersion)
  return skillsBlockForBundle(bundle, root)
}
