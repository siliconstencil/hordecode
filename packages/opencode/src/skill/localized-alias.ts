import type { Info } from "./index"

// Fork has no opencode-side TUI i18n dicts (upstream imported cli/cmd/tui/i18n/{zh,zht});
// localized aliases resolve to [] until dicts with `tui.skill.<name>.slash` keys exist.
const dictionaries: ReadonlyArray<Record<string, string>> = []

export function localizedAliases(skill: Info) {
  if (!skill.bundled) return []
  return [
    ...new Set(
      dictionaries.flatMap(
        (dict) =>
          (dict[`tui.skill.${skill.name}.slash`] ?? "")
            .split("|")
            .map((alias) => alias.trim())
            .filter(Boolean),
      ),
    ),
  ]
}
