export const PROGRESS_RETENTION_KEEP = 1

function normalize(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120)
}

export function selectRetentionVictims(
  rows: Array<{ id: number; path: string; body: string; last_indexed_at: number }>,
): number[] {
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!r.path.includes("progress.md")) continue
    const key = normalize(r.body)
    const gkey = key.split(" ").slice(0, 4).join(" ").slice(0, 60) || key.slice(0, 30)
    const arr = groups.get(gkey) ?? []
    arr.push(r)
    groups.set(gkey, arr)
  }
  const victims: number[] = []
  for (const arr of groups.values()) {
    if (arr.length <= PROGRESS_RETENTION_KEEP) continue
    arr.sort((a, b) => b.last_indexed_at - a.last_indexed_at || b.id - a.id)
    for (let i = PROGRESS_RETENTION_KEEP; i < arr.length; i++) victims.push(arr[i]!.id)
  }
  return victims
}
