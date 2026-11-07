import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Path as GlobalPath } from "@opencode-ai/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Hash } from "@opencode-ai/core/util/hash"
import { Log } from "@opencode-ai/core/util"
import { loadBuiltinBundle } from "./bundle.macro" with { type: "macro" }
import { loadBuiltinBundle as loadBuiltinBundleDev } from "./bundle.macro"

export const OFFICIAL_SKILL_NAMES = new Set([
  "docx-official",
  "pdf-official",
  "pptx-official",
  "xlsx-official",
  "html-to-video-pipeline",
])

const DOCUMENT_SKILL_TRIGGERS: Array<{
  skill: string
  mimes: readonly string[]
  filenameRe: RegExp
}> = [
  {
    skill: "pdf-official",
    mimes: ["application/pdf"],
    filenameRe: /\.pdf$/i,
  },
  {
    skill: "docx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/msword",
    ],
    filenameRe: /\.(docx|dotx)$/i,
  },
  {
    skill: "xlsx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "application/vnd.ms-excel",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "text/csv",
      "text/tab-separated-values",
    ],
    filenameRe: /\.(xlsx|xlsm|xltx|csv|tsv)$/i,
  },
  {
    skill: "pptx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
    ],
    filenameRe: /\.pptx$/i,
  },
]

export function builtinSkillRoot() {
  return path.join(GlobalPath.data, "builtin_skills", InstallationVersion, "skills")
}

export function matchDocumentSkills(candidates: Array<{ mime?: string; filename?: string }>): string[] {
  const hits = new Set<string>()
  for (const candidate of candidates) {
    for (const trigger of DOCUMENT_SKILL_TRIGGERS) {
      if (candidate.mime && trigger.mimes.includes(candidate.mime)) {
        hits.add(trigger.skill)
        continue
      }
      if (candidate.filename && trigger.filenameRe.test(candidate.filename)) {
        hits.add(trigger.skill)
      }
    }
  }
  return DOCUMENT_SKILL_TRIGGERS.filter((t) => hits.has(t.skill)).map((t) => t.skill)
}

function safeLoadBuiltinBundle() {
  try {
    return loadBuiltinBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadBuiltinBundleDev()
    }
    throw e
  }
}
const BUILTIN_BUNDLE = safeLoadBuiltinBundle()

const log = Log.create({ service: "skill.builtin" })

// Identity of the files this process would write, keyed by the official-skills
// flag so the marker also changes when HORDECODE_DISABLE_OFFICIAL_SKILLS flips.
// Two entries at most; this is not an extraction result cache (nothing captures
// an fsys instance).
const identities = new Map<boolean, string>()

function bundleIdentity(disableOfficial: boolean) {
  const known = identities.get(disableOfficial)
  if (known) return known
  const identity = Hash.sha256(
    JSON.stringify(
      Object.entries(BUILTIN_BUNDLE)
        .filter(([skillName]) => !(disableOfficial && OFFICIAL_SKILL_NAMES.has(skillName)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([skillName, files]) => [
          skillName,
          Object.keys(files)
            .sort()
            .map((relPath) => [relPath, files[relPath]]),
        ]),
    ),
  ).slice(0, 16)
  identities.set(disableOfficial, identity)
  return identity
}

export const extractBuiltinBundle = Effect.fn("Skill.extractBuiltinBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const skillsRoot = builtinSkillRoot()
  const root = path.dirname(skillsRoot)
  const disableOfficial = Flag.HORDECODE_DISABLE_OFFICIAL_SKILLS
  // The marker carries the content hash of the bundle, so dev/test/local builds
  // (InstallationLocal, which used to skip the marker entirely) extract once per
  // data root instead of once per Skill layer build, and still re-extract when the
  // embedded bundle or the official-skills flag changes.
  const marker = path.join(root, `.extracted-${bundleIdentity(disableOfficial)}`)

  if (yield* fsys.existsSafe(marker)) return root

  // Files are independent; writing them concurrently takes a third of the time of one at a time.
  yield* Effect.forEach(
    Object.entries(BUILTIN_BUNDLE).filter(
      ([skillName]) => !(disableOfficial && OFFICIAL_SKILL_NAMES.has(skillName)),
    ),
    ([skillName, files]) =>
      Effect.forEach(
        Object.entries(files),
        ([relPath, content]) => fsys.writeWithDirs(path.join(skillsRoot, skillName, relPath), content),
        { concurrency: 16, discard: true },
      ),
    { concurrency: 4, discard: true },
  )
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted builtin skills", { root })
  return root
})
