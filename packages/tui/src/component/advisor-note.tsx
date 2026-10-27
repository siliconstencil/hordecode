import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"

// Fork addition (FORK_ONLY). Renders the advisor's review of a step. The server stores it on the
// step's assistant message as an ignored text part with `metadata.advisor` (session/prompt.ts);
// ignored parts are display only and never replayed to a model.

export type AdvisorSeverity = "nit" | "concern" | "blocker"
export type AdvisorNoteItem = { severity: AdvisorSeverity; note: string }

// Pure: reads `metadata.advisor`, or undefined when the part is not an advisor review. Exported for tests.
export function advisorView(
  metadata: unknown,
): { header: string; notes: AdvisorNoteItem[]; failed: boolean } | undefined {
  const advisor = (metadata as { advisor?: { notes?: unknown; reasons?: unknown; failed?: unknown } } | undefined)
    ?.advisor
  if (!advisor || typeof advisor !== "object") return undefined
  const notes = (Array.isArray(advisor.notes) ? advisor.notes : []).flatMap((item): AdvisorNoteItem[] => {
    const raw = item as { severity?: unknown; note?: unknown }
    if (typeof raw.note !== "string") return []
    const severity = raw.severity === "blocker" || raw.severity === "concern" ? raw.severity : "nit"
    return [{ severity, note: raw.note }]
  })
  // The review did not run or did not finish (model not available, timeout, provider error).
  if (typeof advisor.failed === "string" && advisor.failed)
    return { header: `review failed: ${advisor.failed}`, notes: [], failed: true }
  const blockers = notes.filter((n) => n.severity === "blocker").length
  const header =
    notes.length === 0
      ? "reviewed this step, no notes"
      : [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`, ...(blockers > 0 ? [`${blockers} blocker`] : [])].join(
          " · ",
        )
  return { header, notes, failed: false }
}

export function AdvisorNote(props: { metadata: unknown }) {
  const { theme } = useTheme()
  const view = createMemo(() => advisorView(props.metadata))
  const color = (severity: AdvisorSeverity) =>
    severity === "blocker" ? theme.error : severity === "concern" ? theme.warning : theme.textMuted
  return (
    <Show when={view()}>
      {(v) => (
        <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
          <text fg={theme.textMuted}>
            <span style={{ bg: theme.backgroundElement, fg: theme.accent, bold: true }}> Advisor </span>
            <span style={{ fg: v().failed ? theme.error : theme.textMuted }}> {v().header}</span>
          </text>
          <For each={v().notes}>
            {(item) => (
              <text fg={theme.text} paddingLeft={2}>
                <span style={{ fg: color(item.severity), bold: true }}>{item.severity}</span>
                <span style={{ fg: theme.text }}> {item.note}</span>
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}
