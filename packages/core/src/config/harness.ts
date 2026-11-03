import { Schema } from "effect"
import path from "path"
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
 * Every harness output location, derived from `harness.docs`. With the default config the layout is
 * unchanged (evidence stays in `.hordecode/harness/evidence`); with a custom `docs` the stage summaries,
 * eval files, the eval SUMMARY and the evidence all move under it.
 */
export function harnessPaths(worktree: string, cfg?: Info) {
  const docs = resolveDocsDir(worktree, cfg)
  const custom = cfg?.docs !== undefined && cfg.docs !== DEFAULT_DOCS_DIR
  const join = (...parts: string[]) => (path.isAbsolute(docs) ? path.join(docs, ...parts) : [docs, ...parts].join("/"))
  return {
    docs,
    stages: join("stages"),
    eval: join("eval"),
    evalSummary: join("eval", "SUMMARY.md"),
    evidence: custom ? join("evidence") : DEFAULT_EVIDENCE_DIR,
  }
}
export * as ConfigHarness from "./harness"
