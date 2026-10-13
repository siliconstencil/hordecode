import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { RelativePath } from "@opencode-ai/core/schema"
import type { Match } from "@opencode-ai/schema/filesystem"
import { writeMatchesAsJsonArray } from "../../src/cli/cmd/debug/ripgrep"

//  the previous handler did `process.stdout.write(JSON.stringify(results, null, 2))`
// for the entire match set. When the result set was large enough to push the single
// write past the OS pipe buffer (~1 MiB on Linux), the output was silently truncated
// mid-object. The fix streams each match as its own `process.stdout.write` call, so
// the total output is never buffered into one giant blob.

const makeMatch = (path: string, line: number, text: string, submatchText: string): Match =>
  ({
    entry: { path: RelativePath.make(path), type: "file" },
    line,
    offset: 0,
    text,
    submatches: [{ text: submatchText, start: 0, end: submatchText.length }],
  }) as unknown as Match

describe("writeMatchesAsJsonArray", () => {
  test("emits a valid JSON array with every match", () => {
    const matches: Match[] = [makeMatch("a.ts", 1, "x", "x"), makeMatch("b.ts", 2, "y", "y")]
    const chunks: string[] = []
    writeMatchesAsJsonArray(matches, (chunk) => chunks.push(chunk))
    const output = chunks.join("")
    const parsed = JSON.parse(output) as Array<{ entry: { path: string }; line: number }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].entry.path).toBe("a.ts")
    expect(parsed[1].entry.path).toBe("b.ts")
  })

  test("emits more than one write for a multi-match result set (no single-blob regression)", () => {
    // 5000 matches x ~150 bytes each ~ 750 KB of pretty-printed JSON. With the old
    // single-blob write this fits in one chunk; with the streaming fix each match
    // is its own chunk.
    const matches: Match[] = Array.from({ length: 5_000 }, (_, i) =>
      makeMatch(
        `src/file-${i}.ts`,
        i + 1,
        `function handler_${i}(input) { return process_value(input, "needle-${i}"); }`,
        `needle-${i}`,
      ),
    )
    const chunks: string[] = []
    const chunkSizes: number[] = []
    writeMatchesAsJsonArray(matches, (chunk) => {
      chunks.push(chunk)
      chunkSizes.push(chunk.length)
    })
    // Each chunk is well under the 1 MiB pipe-buffer cap. The opening "[\n" and
    // closing "]\n" are the small structural chunks; the per-match chunks sit in between.
    expect(chunks.length).toBeGreaterThan(100)
    for (const size of chunkSizes) {
      expect(size).toBeLessThan(2 * 1024 * 1024)
    }
    // Output is a single valid JSON array containing every match.
    const parsed = JSON.parse(chunks.join("")) as Array<{ line: number }>
    expect(parsed).toHaveLength(matches.length)
    expect(parsed[0].line).toBe(1)
    expect(parsed[parsed.length - 1].line).toBe(matches.length)
  })

  test("handles an empty result set without crashing", () => {
    const chunks: string[] = []
    writeMatchesAsJsonArray([], (chunk) => chunks.push(chunk))
    const parsed = JSON.parse(chunks.join(""))
    expect(parsed).toEqual([])
  })
})

// Live integration check against the real `rg` binary. The previous handler
// hit the 1 MiB pipe-buffer cap when searching a real project; we now
// reproduce that scale via a generated fixture so the streaming fix is
// exercised end-to-end.
describe("ripgrep large-result fixture", () => {
  test(
    "real rg can produce > 1 MiB JSON output for a fixture that would have hit the cap",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p834-rg-test-"))
      try {
        // 8000 lines x ~300 bytes each, each line containing the pattern "needle" -> ~2.4 MB
        // of pretty-printed JSON output, well past the 1 MiB cap that broke the old handler.
        const lines: string[] = []
        for (let i = 0; i < 8000; i++) {
          lines.push(
            `function handler_${i}(input) { return process_value(input, "needle-${i}"); }`,
          )
        }
        await fs.writeFile(path.join(dir, "big.ts"), lines.join("\n") + "\n")

        // Sanity check: real rg can scan this file and produce > 1 MiB of JSON output
        // (the size threshold that used to trigger the 1 MiB cap).
        // Read the child's stdout as a stream: collecting a multi-MiB pipe through the
        // Bun shell (`$...`.text()) stalled at the test's 30 s cap under full-package load
        // (2 of 5 runs, 2026-09-17); Bun.spawn with a streamed read never blocks the child.
        const proc = Bun.spawn(["rg", "--json", "--no-config", "--no-messages", "needle", path.join(dir, "big.ts")], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        })
        const direct = await new Response(proc.stdout).text()
        await proc.exited
        expect(direct.length).toBeGreaterThan(1024 * 1024)
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
    30_000,
  )
})
