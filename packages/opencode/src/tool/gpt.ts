// GPT-family model detection helpers. Ported from MiMo Code
// v0.1.11 (packages/opencode/src/tool/gpt.ts). UsesGPTToolset gates the GPT generation compatibility rules on the
// selected model: gpt-* families except gpt-4 (legacy toolset) and gpt-oss.

export function isGPTModel(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => id.includes("gpt-oss"))) return false
  return ids.some((id) => id.includes("gpt"))
}

export function isMcpToolSearchEnabled(enabled: boolean, ...modelIDs: Array<string | undefined>) {
  return enabled || isGPTModel(...modelIDs)
}

export function usesGPTToolset(modelID: string) {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}
