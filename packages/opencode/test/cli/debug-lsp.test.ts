//  `hordecode debug lsp` regression. The previous describe was a single
// line ("LSP debugging utilities") that didn't tell the operator that all
// three subcommands (diagnostics, symbols, document-symbols) silently
// return `{}` / `[]` whenever the user has not set `lsp: true` or any
// per-server entry in their config -- which is the fork default. An
// operator who ran `hordecode debug lsp diagnostics src/foo.ts` in a real
// project with no LSP config got an empty object back and no hint why.
//
// The fix expands the top-level + per-subcommand describe text to call
// out the disabled-by-default contract and point at the config knob.
// The handlers themselves are unchanged (still emit `{}` / `[]`) so any
// downstream JSON consumer keeps working; the disambiguation is in the
// help output, which is what an operator reads first.
//
// Two tests pin this:
//   1. `hordecode debug lsp --help` describe text must mention "disabled" and
//      the `lsp: true` config knob, so the help output surfaces the
//      disabled-by-default contract on first read.
//   2. A genuine subprocess call to `hordecode debug lsp diagnostics <file>`
//      must exit 0 and emit the documented empty diagnostics object (`{}`),
//      so a future refactor that crashes on a disabled LSP regresses
//      loudly instead of silently -- and so the empty-object contract is
//      itself locked down.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode debug lsp describe", () => {
  cliIt.live(
    "`debug lsp --help` describes the disabled-by-default contract",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["debug", "lsp", "--help"], {
          timeoutMs: 10_000,
          env: { COLUMNS: "120" },
        })
        expect(result.exitCode).toBe(0)
        // yargs writes --help to stderr. The describe must explicitly call
        // out the disabled-by-default state -- otherwise the operator
        // doesn't know the silent-empty behavior is intentional.
        expect(result.stderr).toMatch(/no-op|disabled/i)
        // And it must point at the config knob that flips the state, so
        // the operator has a next step instead of a dead end.
        expect(result.stderr).toMatch(/lsp:\s*true|`lsp`/)
        // Every subcommand describe must also document its empty-output
        // contract, so a per-subcommand --help surfaces it too (operators
        // don't always read the parent command's --help first).
        expect(result.stderr).toMatch(/diagnostics/)
        expect(result.stderr).toMatch(/symbols/)
        expect(result.stderr).toMatch(/document-symbols/)
        // The empty-output contract itself: diagnostics returns `{}`,
        // symbols + document-symbols return `[]`. Lock the shape so a
        // future handler rewrite doesn't change it without noticing.
        expect(result.stderr).toMatch(/\{\}/)
        expect(result.stderr).toMatch(/\[\]/)
      }),
    30_000,
  )
})

describe("opencode debug lsp diagnostics", () => {
  cliIt.live(
    "diagnostics exits 0 and emits `{}` when all LSPs are disabled",
    ({ opencode }) =>
      Effect.gen(function* () {
        // The fixture's opencode.json has no `lsp` entry, so this run
        // exercises the cfg.lsp === undefined branch in lsp.ts:151
        // ("all LSPs are disabled"). Pre- this still exited 0 with
        // `{}`; the substantive guard here is that the contract holds --
        // exit 0, stdout is exactly `{}` (not a crash, not a stray
        // non-JSON line) -- so a future change that, say, throws a
        // NotFoundError or omits the EOL breaks this test instead of
        // shipping.
        const result = yield* opencode.spawn(
          ["debug", "lsp", "diagnostics", "src/cli/cmd/debug/lsp.ts"],
          { timeoutMs: 15_000 },
        )
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe("{}")
      }),
    30_000,
  )
})
