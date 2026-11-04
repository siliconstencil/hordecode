import { Schema } from "effect"
import path from "path"
import { createHash } from "crypto"
import { Global } from "../global"
import { zod } from "@opencode-ai/core/util/effect-zod"
import { withStatics } from "@opencode-ai/core/util/schema"

export const Info = Schema.Struct({
  docs: Schema.optional(Schema.String).annotate({
    description: "Directory where harness skills save specs, plans, and reports. Relative paths are passed to the agent prompt verbatim; set docs_absolute: true to anchor them to the project root. Defaults to docs/harness.",
  }),
  docs_absolute: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether the docs directory injected into the harness prompt is an absolute path. When false (default), a relative `docs` value is passed through verbatim. When true, a relative `docs` is resolved against the active worktree root so it is unambiguous regardless of the agent's working directory. Ignored when `docs` is already absolute.",
  }),
  triage: Schema.optional(Schema.Boolean).annotate({
    description:
      "Let the harness agent skip brainstorm, plan and tdd for a request that is a mechanical edit: one sentence, one named file, ASCII English and a known small-change phrase such as fixing a typo or bumping the version. Everything else, including every non-English request, keeps the full pipeline. Default false: the harness prompt is unchanged.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_DOCS_DIR = "docs/harness"

export function resolveDocsDir(worktree: string, cfg?: Info) {
  const configured = cfg?.docs ?? DEFAULT_DOCS_DIR
  if (path.isAbsolute(configured) || cfg?.docs_absolute === true) return path.resolve(worktree, configured)
  return configured
}
export const DEFAULT_EVIDENCE_DIR = ".hordecode/harness/evidence"

/**
 * Every harness output location, absolute, derived from `harness.docs`, so neither the model nor a
 * subagent has to substitute anything. Stage summaries, eval JSON and the eval SUMMARY live under the
 * configured docs dir. Evidence stays out of the docs tree (usually committed): with the default docs dir
 * it is `<worktree>/.hordecode/harness/evidence` (unchanged); with a custom docs dir it is
 * `<state>/harness-evidence/<hash of the worktree>`.
 * MiMo Code 0.1.11 packages/opencode/src/session/prompt.ts:936-944 resolves only the docs dir in the
 * prompt (specs, plans, reports) and has no stage, eval or evidence paths.
 */
export function harnessPaths(worktree: string, cfg?: Info, stateDir: string = Global.Path.state) {
  const docs = path.resolve(worktree, cfg?.docs ?? DEFAULT_DOCS_DIR)
  const custom = docs !== path.resolve(worktree, DEFAULT_DOCS_DIR)
  const key = createHash("sha256").update(path.resolve(worktree)).digest("hex").slice(0, 32)
  return {
    docs,
    stages: path.join(docs, "stages"),
    eval: path.join(docs, "eval"),
    evalSummary: path.join(docs, "eval", "SUMMARY.md"),
    evidence: custom
      ? path.join(stateDir, "harness-evidence", key)
      : path.join(path.resolve(worktree), DEFAULT_EVIDENCE_DIR),
  }
}
export * as ConfigHarness from "./harness"
