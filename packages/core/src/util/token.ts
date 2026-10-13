export * as Token from "./token"

const CHARS_PER_TOKEN = 4

export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

export function parseQuantity(raw: number | string, hard: number): number | undefined {
  if (typeof raw === "number") return raw
  const s = raw.trim()
  if (s === "") return undefined
  if (s.endsWith("%")) {
    const pct = Number(s.slice(0, -1))
    if (!Number.isFinite(pct)) return undefined
    return Math.floor((hard * pct) / 100)
  }
  const m = s.match(/^([\d.]+)\s*([KkMm])?$/)
  if (!m) return undefined
  const num = Number(m[1])
  if (!Number.isFinite(num)) return undefined
  const suffix = (m[2] ?? "").toLowerCase()
  if (suffix === "k") return Math.floor(num * 1000)
  if (suffix === "m") return Math.floor(num * 1000000)
  return Math.floor(num)
}
