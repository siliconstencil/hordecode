export type Counts = { tool: string; run: number; passed: number }

const num = (text: string | undefined) => (text === undefined ? 0 : Number(text))

const bun = (out: string): Counts | undefined => {
  const ran = /^Ran (\d+) tests? across \d+ files?/m.exec(out)
  if (!ran) return undefined
  return { tool: "bun", run: num(ran[1]), passed: num(/^\s*(\d+) pass$/m.exec(out)?.[1]) }
}

const jest = (out: string): Counts | undefined => {
  const line = /^Tests:\s+(.+)$/m.exec(out)?.[1]
  const total = line && /(\d+) total/.exec(line)?.[1]
  if (!line || total === undefined) return undefined
  return { tool: "jest", run: num(total), passed: num(/(\d+) passed/.exec(line)?.[1]) }
}

const vitest = (out: string): Counts | undefined => {
  const line = /^\s*Tests\s{2,}(.+)$/m.exec(out)?.[1]
  const total = line && /\((\d+)\)\s*$/.exec(line)?.[1]
  if (!line || total === undefined) return undefined
  return { tool: "vitest", run: num(total), passed: num(/(\d+) passed/.exec(line)?.[1]) }
}

const PYTEST_KINDS = new Set(["passed", "failed", "skipped", "error", "errors", "xfailed", "xpassed"])

const pytest = (out: string): Counts | undefined => {
  const lines = out.split("\n").flatMap((raw) => {
    const line = raw.replace(/^[=\s]+|[=\s]+$/g, "")
    if (/^no tests ran in [\d.]+\s*s/i.test(line)) return [{ run: 0, passed: 0 }]
    const m = /^((?:\d+ [a-z]+(?:, | and )?)+)\s+in\s+[\d.]+\s*s/i.exec(line)
    if (!m) return []
    const pairs = [...m[1]!.matchAll(/(\d+) ([a-z]+)/gi)].map((p) => [p[2]!.toLowerCase(), Number(p[1])] as const)
    return [
      {
        run: pairs.filter(([k]) => PYTEST_KINDS.has(k)).reduce((n, [, v]) => n + v, 0),
        passed: pairs.filter(([k]) => k === "passed").reduce((n, [, v]) => n + v, 0),
      },
    ]
  })
  const last = lines.at(-1)
  return last ? { tool: "pytest", ...last } : undefined
}

const cargo = (out: string): Counts | undefined => {
  const rows = [...out.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)]
  if (rows.length === 0) return undefined
  return {
    tool: "cargo",
    run: rows.reduce((n, r) => n + num(r[1]) + num(r[2]) + num(r[3]), 0),
    passed: rows.reduce((n, r) => n + num(r[1]), 0),
  }
}

const go = (out: string): Counts | undefined => {
  // Without -v go test prints only the failing tests, so a count is trusted only next to the === RUN lines of -v.
  if (!/^=== RUN /m.test(out)) return undefined
  const rows = [...out.matchAll(/^\s*--- (PASS|FAIL|SKIP): /gm)]
  if (rows.length === 0) return undefined
  return { tool: "go", run: rows.length, passed: rows.filter((r) => r[1] === "PASS").length }
}

/**
 * Test counts of a runner's own summary, or undefined when the output is not a recognized one: bun test,
 * jest, vitest, pytest, cargo test, and go test -v (go test without -v prints no counts). Formats that are
 * summed over the whole output (cargo, go) are not trusted when the output was cut at the parse window.
 */
export function parse(output: string, truncated = false): Counts | undefined {
  return bun(output) ?? jest(output) ?? vitest(output) ?? pytest(output) ?? (truncated ? undefined : (cargo(output) ?? go(output)))
}
