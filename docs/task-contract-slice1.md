# Task contract, first slice (prototype)

Branch `rnd/task-contract-slice1`. Prototype for the owner to try before deciding. Scope is section 4
of the design note; everything under its "Deferred" list is out (LLM verifier, USD/token/wall
enforcement, notification delivery, durable resume, per-model gating, changes to the three existing
gates).

## Usage

Arm a contract in a session with the `/contract` command. Segments are separated by a newline or by
` ;; `. The first segment is the objective, `protect: <path>` names an extra protected path, every
other segment is a criterion command.

```
/contract Make the parser reject empty input ;; bun test ;; ./scripts/check.sh --strict ;; protect: fixtures
/contract status
/contract clear
```

What happens:

1. Arming hashes (SHA-256) every test file in the project (`*.test.*`, `*.spec.*`, `test/`, `tests/`,
   `__tests__/`, `test_*.py`, `*_test.go`, ...) plus every file under a `protect:` path. A protect path
   must exist and stay inside the project. The spec text is then sent to the agent as its task.
2. When the agent tries to stop, the product (not the agent) runs each criterion in the session
   directory. Each run asks the permission system (`bash` permission, pattern = the command). The
   agent's claims in text do not count.
3. Each run records exit code, a deterministic output hash and a log file. With
   `HORDECODE_PERMISSION_AUDIT=1` each run is also a `contract_evidence` line in the hash-chained
   permission log (`horde debug audit-verify` verifies the chain).
4. The test files are re-hashed. A modified, deleted or added test file ends the contract as `failed`,
   even when every criterion passes.
5. A failing criterion injects a synthetic user turn naming the command, the exit code and the output
   tail, and the loop continues. After 3 re-entries the contract becomes `blocked`, never `verified`.
6. If permission for a criterion is not granted the contract becomes `unverified`.

Final states: `verified`, `failed` (test integrity), `blocked` (re-entries exhausted), `unverified`
(could not judge). With no contract armed nothing changes.

The report is written after every gate run to
`<data dir>/contracts/<session id>/report.md` (plus `contract.json` and one `C<n>-<attempt>.log`
per run), outside the project tree. `/contract status` prints the path. Example:

```
# Contract ctr_1a2b3c4d: BLOCKED because: C2 still failing after 3 re-entries

Objective: Make the parser reject empty input
Session: ses_...
Re-entries: 3 of 3

## Criteria

| id | state | command | last exit | runs |
|---|---|---|---|---|
| C1 | passed | `bun test` | 0 | 4 |
| C2 | failed | `./scripts/check.sh --strict` | 1 | 4 |

## Evidence

- C2 attempt 4: exit 1, 812 ms, started 2026-11-04T02:14:09.000Z
  output sha256: 9f2c...
  log: .../contracts/ses_.../C2-4.log

## Test integrity

Protected files at arm time: 41
Violations: none recorded

## Audit

Each run is a `contract_evidence` line in .../permission.jsonl; verify the chain with `horde debug audit-verify`.
```

Overnight caveat: with the conservative permission default, a criterion that is not already allowed
by a rule waits for a human reply (5 minute bound) and then the contract is `unverified`. Allow the
commands with a `bash` permission rule, or flip decision 3 below.

## Where the code is

| File | Class | Content |
|---|---|---|
| `packages/task/src/contract.ts` | FORK_ONLY (new) | schema, in-memory store, `/contract` parser, re-entry text |
| `packages/task/src/contract-decisions.ts` | FORK_ONLY (new) | one constant per open decision |
| `packages/opencode/src/session/contract/{runner,integrity,report,gate,command}.ts` | FORK_ONLY (new) | runner, integrity check, report writer, stop gate, command handler |
| `packages/task/src/index.ts` | FORK_ONLY | two export lines |
| `packages/opencode/src/session/prompt.ts` | FORK_DELTA | 2 imports, 1 gate construction, 2 gate call lines (after `Goal.runGate`, both stop sites), 1 `/contract` hook; every hunk carries a `FORK_DELTA` citation comment |
| `packages/opencode/src/command/index.ts` | FORK_DELTA | command id `CONTRACT` and its registration next to `/goal` |

`permission/audit.ts` is not edited: `PermissionAudit.write` already takes any entry kind and
`verify` does not look at `kind`, so the design note's "one new entry kind" needed no change there.

## OPEN DECISIONS (owner's; conservative option picked)

Each is a key in `CONTRACT_DECISIONS` (`packages/task/src/contract-decisions.ts`) unless stated.

| # | Choice made | Flip |
|---|---|---|
| 1 Storage | Session-only record in process memory: not agent-editable, no repo file, no DB migration. Lost on process exit (the report on disk survives). | `storage`. Only "session" is implemented; a registry-row or repo-file backend needs code. |
| 2 Where criteria run | The session working directory. | `criteriaCwd`. Only this value is implemented; a worktree/sandbox needs code. |
| 3 Permission | Ask on each run through the permission system. | `criteriaPermission: "trust-once-armed"` (one ask at arm time, none per run; implemented). |
| 4 Verifier | Not in this slice (deferred by the note). No code, no model call. | n/a |
| 5 Protected set | Every test file in the project plus named paths; a new test file is a violation; criterion command files are NOT hashed (residual hole stays open). | `protect: "named-only"`, `allowAddedTests: true`. |
| 6 Caps | Only a re-entry cap (3) and a 120 s per-criterion timeout (timeout counts as a failed criterion). No USD/token/wall enforcement (deferred). | `maxReact`, `criterionTimeoutMs`. |
| 7 Gate placement | Beside the existing gates, after task gate and goal gate, so criteria run once when the others agree to stop. The three existing gates are untouched. | Structural (the order of two lines in `prompt.ts`), not a constant. |
| 8 Git checkpoint | None in this slice (not in the first-slice list); the repo is never mutated by the contract. | n/a |
| 9 Notification | File only, outside the project tree. | `reportDir` (name under the data dir). |
| 10 Mode/agent edit | Invisible, always available as `/contract`. The agent has no tool that writes a contract; only the user-typed command does. Re-arming while active is refused until `/contract clear`. | n/a |

Also decided, not numbered in the note: integrity violation ends the contract as `failed` at once
(`onIntegrityViolation: "reenter"` turns it into a re-entry like a failed criterion).

## Verification (measured)

- `packages/task`: `bun test` 22 pass, 0 fail (new: 8 in `test/contract.test.ts`); `bun run typecheck` clean.
- `packages/opencode`: `bun run typecheck` clean (needs `NODE_OPTIONS=--max-old-space-size=12000`, plain run
  runs out of heap on the unmodified tree too).
- New opencode tests, 28 pass, 0 fail: `test/session/contract/runner.test.ts` (pass, fail, timeout, hash
  determinism, tail cap, credential scrub), `integrity.test.ts` (unchanged, modified, deleted, added, named-only,
  path escape, cap), `report.test.ts`, `contract-turn.test.ts` (session level: criterion fails then passes and
  is verified; cap then blocked; changed test file fails; denied permission is unverified; child session not
  gated; `/contract` command end to end; **no contract: one turn, no synthetic turn, no store entry**).
- Existing gates stay green: `test/session/task-gate-turn.test.ts`, `test/permission`, `test/command`
  (245 pass, 0 fail together with the new session tests); core `goal.test.ts` 10 pass.
- `bun test test/cli/help test/session` in `packages/opencode`: 620 pass, 24 fail with this change; the
  same command on the unmodified tree: 592 pass, 24 fail, the same 24 tests (checkpoint writer, drain,
  rebuild, interrupt cancel scope, task binding). The 10 files containing them pass in isolation with this
  change (27 pass, 0 fail). They are an existing suite-interaction failure, not caused by this slice.

## Not done / evidence gaps

- `../repos/opencode-1.19.5` is not present in this environment, so FORK_DELTA citations point to the
  local `prompt.ts` lines they sit next to (as the design note does). Upstream v1.19.5 has no `/goal`, so
  there is no upstream line for the command hook to cite beyond the neighbouring fork hunk. Line numbers
  were not checked against the upstream tag.
- `docs/upstream-map-files.tsv` was not regenerated (the script needs the reference checkout). The new
  files are FORK_ONLY and `prompt.ts` / `command/index.ts` are already FORK_DELTA; regenerate before merge.
- Not run on the installed binary (FORK-RULES section 7 asks for it before a release); the prototype is
  covered by the fake-LLM session tests only.
- Evidence log files keep the redacted output tail only (16 KiB); the hash covers the full output.
- The store is per process: a restart loses the armed contract (decision 1).
