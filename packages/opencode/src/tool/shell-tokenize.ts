import { Effect } from "effect"
import { parse as shellQuoteParse } from "shell-quote"

export interface Argv {
  line: number
  tokens: string[]
}

export interface ParseError {
  kind: "unclosed-quote" | "unsupported-operator" | "unclosed-heredoc" | "internal"
  line: number
  detail: string
}

function heredocPlaceholder(n: number) {
  return `\x00HD${n}\x00`
}

const HEREDOC_MARKER_HEAD = /[A-Za-z_]/
const HEREDOC_MARKER_TAIL = /[A-Za-z0-9_]/

function parseHeredocMarker(script: string, start: number): { marker: string; end: number } | null {
  let j = start + 2
  if (script[j] === "-") j++
  while (script[j] === " " || script[j] === "\t") j++
  const quote = script[j] === "'" || script[j] === '"' ? script[j] : null
  if (quote) j++
  const markerStart = j
  if (!(j < script.length && HEREDOC_MARKER_HEAD.test(script[j]))) return null
  while (j < script.length && HEREDOC_MARKER_TAIL.test(script[j])) j++
  const marker = script.slice(markerStart, j)
  if (quote) {
    if (script[j] !== quote) return null
    j++
  }
  return { marker, end: j }
}

type HeredocResult =
  | { ok: true; stripped: string; bodies: string[] }
  | { ok: false; error: ParseError }

function extractHeredocs(script: string): HeredocResult {
  const bodies: string[] = []
  let out = ""
  let quote: '"' | "'" | null = null
  let i = 0
  let line = 1

  while (i < script.length) {
    const ch = script[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < script.length) {
        out += ch + script[i + 1]
        if (script[i + 1] === "\n") line++
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        out += ch
        i++
        continue
      }
      if (ch === "\n") line++
      out += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === "<" && script[i + 1] === "<") {
      if (script[i + 2] === "<") {
        out += "<<< "
        i += 3
        while (i < script.length && script[i] !== "\n") i++
        continue
      }
      const opener = parseHeredocMarker(script, i)
      if (opener) {
        const marker = opener.marker
        let k = opener.end
        while (k < script.length && (script[k] === " " || script[k] === "\t")) k++
        if (k < script.length && script[k] !== "\n") {
          return {
            ok: false,
            error: {
              kind: "unsupported-operator",
              line,
              detail: "tokens after <<MARKER on the same line are not supported",
            },
          }
        }
        const bodyIndex = bodies.length
        const openLine = line
        out += heredocPlaceholder(bodyIndex) + "\n"
        i = k + 1
        line++
        const bodyLines: string[] = []
        let closed = false
        while (i < script.length) {
          let lineEnd = i
          while (lineEnd < script.length && script[lineEnd] !== "\n") lineEnd++
          const bodyLine = script.slice(i, lineEnd)
          out += "\n"
          if (bodyLine.trim() === marker) {
            i = lineEnd + (lineEnd < script.length ? 1 : 0)
            line++
            closed = true
            break
          }
          bodyLines.push(bodyLine)
          i = lineEnd + (lineEnd < script.length ? 1 : 0)
          line++
        }
        if (!closed) {
          return {
            ok: false,
            error: {
              kind: "unclosed-heredoc",
              line: openLine,
              detail: `unclosed heredoc <<${marker}`,
            },
          }
        }
        bodies.push(bodyLines.join("\n"))
        continue
      }
      out += ch
      i++
      continue
    }
    out += ch
    if (ch === "\n") line++
    i++
  }
  return { ok: true, stripped: out, bodies }
}

const HD_RE = /^\x00HD(\d+)\x00$/

function preprocessComments(input: string): string {
  let out = ""
  let i = 0
  let quote: '"' | "'" | null = null
  let prevWasBoundary = true
  while (i < input.length) {
    const ch = input[i]
    if (quote) {
      out += ch
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        out += input[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === "\\") {
      if (i + 1 < input.length && input[i + 1] === "#") {
        out += "\\#"
        i += 2
        prevWasBoundary = false
        continue
      }
      out += ch
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === "#") {
      if (prevWasBoundary) {
        while (i < input.length && input[i] !== "\n") i++
        continue
      }
      out += "\\#"
      i++
      prevWasBoundary = false
      continue
    }
    out += ch
    prevWasBoundary = ch === "\n" || /\s/.test(ch)
    i++
  }
  return out
}

export function tokenize(script: string): Effect.Effect<Argv[], ParseError> {
  return Effect.suspend(() => {
    if (script.trim() === "") return Effect.succeed([] as Argv[])

    const heredocResult = extractHeredocs(script)
    if (!heredocResult.ok) return Effect.fail(heredocResult.error)
    const { stripped, bodies } = heredocResult

    const segments = splitTopLevelLines(preprocessComments(stripped)).filter((seg) => seg.text.trim() !== "")
    const out: Argv[] = []
    for (const seg of segments) {
      const unclosed = scanUnclosedQuote(seg.text)
      if (unclosed) {
        return Effect.fail<ParseError>({
          kind: "unclosed-quote",
          line: seg.line,
          detail: `unclosed ${unclosed}-quoted string`,
        })
      }
      const segTokens = shellQuoteParse(seg.text, (name: string) => "$" + name, { escape: "\\" })
      const stringTokens: string[] = []
      for (const t of segTokens) {
        if (typeof t === "string") {
          const match = HD_RE.exec(t)
          if (match) {
            stringTokens.push(bodies[parseInt(match[1], 10)])
            continue
          }
          stringTokens.push(t)
          continue
        }
        if (typeof t === "object" && t !== null && "op" in t) {
          const tok = t as { op: string; pattern?: string }
          const detail =
            tok.op === "glob" && tok.pattern != null
              ? `unsupported glob pattern: ${tok.pattern}`
              : `unsupported shell operator: ${tok.op}`
          return Effect.fail<ParseError>({
            kind: "unsupported-operator",
            line: seg.line,
            detail,
          })
        }
      }
      if (stringTokens.length > 0) out.push({ line: seg.line, tokens: stringTokens })
    }
    return Effect.succeed(out)
  })
}

function scanUnclosedQuote(segment: string): '"' | "'" | null {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
  }
  return quote
}

function splitTopLevelLines(script: string): Array<{ line: number; text: string }> {
  const segments: Array<{ line: number; text: string }> = []
  let buf = ""
  let segStart = 1
  let line = 1
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < script.length) {
    const ch = script[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < script.length) {
        buf += ch + script[i + 1]
        if (script[i + 1] === "\n") line++
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        buf += ch
        i++
        continue
      }
      if (ch === "\n") line++
      buf += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      i++
      continue
    }
    if (ch === "\\" && i + 1 < script.length && script[i + 1] === "\n") {
      line++
      i += 2
      continue
    }
    if (ch === "\n") {
      segments.push({ line: segStart, text: buf })
      buf = ""
      line++
      segStart = line
      i++
      continue
    }
    buf += ch
    i++
  }
  if (buf.length > 0) segments.push({ line: segStart, text: buf })
  return segments
}
