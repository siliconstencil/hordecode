export function extractEntities(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ")
    if (!t || t.length < 2) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }

  // Quoted entities: "foo", 'foo', `foo`
  const quotedRe = /"([^"]{2,})"|'([^']{2,})'|`([^`]{2,})`/g
  let m: RegExpExecArray | null
  while ((m = quotedRe.exec(text)) !== null) {
    const val = m[1] ?? m[2] ?? m[3]
    if (val) push(val)
  }

  // Proper nouns: sequences of Capitalized words (at least 2 chars per word)
  const properRe = /\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})*\b/g
  while ((m = properRe.exec(text)) !== null) {
    const val = m[0]!
    if (val.length < 3) continue
    push(val)
  }
  // CamelCase single-token entities like AcmeCorp, ProjectZircon
  const camelRe = /\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b/g
  while ((m = camelRe.exec(text)) !== null) push(m[0]!)

  // Hyphenated / compound identifiers like acme-corp or Project_Zircon considered entity if contains hyphen/underscore and letters
  const compoundRe = /\b[a-zA-Z][a-zA-Z0-9]*[-_][a-zA-Z0-9_-]+\b/g
  while ((m = compoundRe.exec(text)) !== null) push(m[0]!)

  return out
}

export function expandContext(body: string, snippet: string): string {
  if (!body || !snippet) return snippet ?? body ?? ""
  const lowerBody = body.toLowerCase()
  const lowerSnip = snippet.toLowerCase().replace(/<<|>>/g, "").trim()
  // find snippet's core token in body
  let idx = -1
  if (lowerSnip.length >= 3) {
    // try first meaningful token
    const token = lowerSnip.split(/\s+/)[0] ?? lowerSnip
    idx = lowerBody.indexOf(token.toLowerCase())
    if (idx === -1) idx = lowerBody.indexOf(lowerSnip.slice(0, 20).toLowerCase())
  }
  if (idx === -1) return body.slice(0, 600)
  const lines = body.split("\n")
  let lineIdx = 0
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length + 1
    if (pos + len > idx) {
      lineIdx = i
      break
    }
    pos += len
  }
  const start = Math.max(0, lineIdx - 1)
  const end = Math.min(lines.length, lineIdx + 2)
  const expanded = lines.slice(start, end).join("\n")
  return expanded.length > snippet.length ? expanded : snippet
}

export const ENTITY_BOOST = 0.15
