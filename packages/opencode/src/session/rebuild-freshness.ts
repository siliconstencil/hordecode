// Fork-only rebuild freshness decision. A rebuild at boundary B discards the
// messages before B and replaces them with the checkpoint's synthetic context
// (bounded by REBUILD_CONTEXT_RESERVE). If that still leaves the context at or
// over the overflow window, the rebuild cannot bound the turn and the caller
// must fall back to plain compaction. MiMo v0.1.11/0.1.12 reuse any checkpoint
// without this check (packages/opencode/src/session/prompt.ts:459).

// Same 13k the prune ladder reserves for checkpoint context
// (packages/core/src/session/prune.ts CHECKPOINT_RESERVED).
export const REBUILD_CONTEXT_RESERVE = 13_000

export function rebuildCoversContext(input: {
  contextTokens: number
  droppedTokens: number
  usableLimit: number
}): boolean {
  return input.contextTokens - input.droppedTokens + REBUILD_CONTEXT_RESERVE < input.usableLimit
}

export * as RebuildFreshness from "./rebuild-freshness"
