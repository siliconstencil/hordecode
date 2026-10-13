export const RRF_K = 60

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export function adaptiveFtsWeight(avgIdf: number): number {
  // sigmoid centered at 2, scaled to ~0.5..1.5 range: weight = 0.5 + sigmoid(avgIdf-2)
  return 0.5 + sigmoid(avgIdf - 2)
}

export function distanceGate(cosine: number, threshold = 0.35): boolean {
  // true = gated (abstain/filter), cosine below threshold means too distant
  return cosine < threshold
}

export function fuseRrf(ftsRanks: Map<string, number>, vecRanks: Map<string, number>, k = RRF_K): Map<string, number> {
  const allIds = new Set<string>([...ftsRanks.keys(), ...vecRanks.keys()])
  const fused = new Map<string, number>()
  for (const id of allIds) {
    let s = 0
    const fr = ftsRanks.get(id)
    if (fr !== undefined) s += 1 / (k + fr)
    const vr = vecRanks.get(id)
    if (vr !== undefined) s += 1 / (k + vr)
    fused.set(id, s)
  }
  return fused
}

export function fuseRrfWeighted(
  ftsRanks: Map<string, number>,
  vecRanks: Map<string, number>,
  ftsWeight = 1,
  vecWeight = 1,
  k = RRF_K,
): Map<string, number> {
  const allIds = new Set<string>([...ftsRanks.keys(), ...vecRanks.keys()])
  const fused = new Map<string, number>()
  for (const id of allIds) {
    let s = 0
    const fr = ftsRanks.get(id)
    if (fr !== undefined) s += ftsWeight / (k + fr)
    const vr = vecRanks.get(id)
    if (vr !== undefined) s += vecWeight / (k + vr)
    fused.set(id, s)
  }
  return fused
}

function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  const tb = new Set(b.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  if (ta.size === 0 && tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function mmrSelect<T extends { id: string; score: number; body: string; embedding?: Float32Array }>(
  candidates: T[],
  lambda = 0.5,
  k: number = candidates.length,
): T[] {
  if (candidates.length === 0) return []
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const cap = Math.min(k, sorted.length, 20)
  // normalize scores to 0..1 for MMR formula
  const maxScore = sorted[0]!.score
  const minScore = sorted[sorted.length - 1]!.score
  const range = maxScore - minScore || 1
  const norm = (s: number) => (s - minScore) / range
  const selected: T[] = []
  const remaining = [...sorted]
  // first pick highest score
  selected.push(remaining.shift()!)
  while (selected.length < cap && remaining.length > 0) {
    let bestIdx = -1
    let bestMmr = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!
      let maxSim = 0
      for (const sel of selected) {
        let sim = 0
        if (cand.embedding && sel.embedding) sim = cosineSim(cand.embedding, sel.embedding)
        else sim = jaccard(cand.body, sel.body)
        if (sim > maxSim) maxSim = sim
      }
      const mmr = lambda * norm(cand.score) - (1 - lambda) * maxSim
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }
    if (bestIdx === -1) break
    selected.push(remaining.splice(bestIdx, 1)[0]!)
  }
  return selected
}

export function typeBoost(type: string): number {
  if (type === "decision") return 1.25
  if (type === "problem") return 1.15
  return 1.0
}

export function timeDecay(lastIndexedAt: number, now = Date.now()): number {
  return Math.exp((Math.log(0.5) / (14 * 24 * 60 * 60 * 1000)) * Math.max(0, now - lastIndexedAt))
}

export function floorFilter<T extends { score: number }>(rows: T[], floorRatio: number): T[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort((a, b) => b.score - a.score)
  const topScore = sorted[0]!.score
  return sorted.filter((r, i) => i === 0 || r.score >= topScore * floorRatio)
}
