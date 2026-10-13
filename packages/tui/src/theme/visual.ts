export type VisualTheme = "dark" | "light" | "system"
export type ResolvedVisual = "dark" | "light"

export function resolveVisualTheme(pref: VisualTheme): ResolvedVisual {
  if (pref !== "system") return pref
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light"
  return "dark"
}

export function visualToTheme(v: ResolvedVisual): "vivid" | "minimal" {
  return v === "dark" ? "vivid" : "minimal"
}
