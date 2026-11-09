// Fork-only rebuild freshness decision. A rebuild at boundary B discards the
// messages before B and replaces them with the checkpoint's rendered rebuild
// context. If that still leaves the context at or over the overflow window, the
// rebuild cannot bound the turn and the caller must fall back to plain
// compaction. MiMo v0.1.11/0.1.12 reuse any checkpoint without this check
// (packages/opencode/src/session/prompt.ts:459).
export function rebuildCoversContext(input: {
  contextTokens: number
  droppedTokens: number
  syntheticTokens: number
  usableLimit: number
}): boolean {
  return input.contextTokens - input.droppedTokens + input.syntheticTokens < input.usableLimit
}

export * as RebuildFreshness from "./rebuild-freshness"
