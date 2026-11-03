# Task contract, first slice (prototype)

Branch `rnd/task-contract-slice1`. Prototype for the owner to try before deciding. Scope is section 4
of the design note plus three opt-in additions (safety envelope, git checkpoint, unattended flag),
all OFF by default. Still out: the LLM verifier, token enforcement, notification delivery, durable
resume, per-model gating, changes to the three existing gates.

## Usage

Arm a contract in a session with the `/contract` command. Segments are separated by a newline or by
` ;; `. The first segment is the objective, `protect: <path>` names an extra protected path, a bare
`unattended` segment sets the unattended flag, every other segment is a criterion command.

```
/contract Make the parser reject empty input ;; bun test ;; ./scripts/check.sh --strict ;; protect: fixtures
/contract Fix the build ;; bun run build ;; unattended
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
   With the `unattended` flag the criteria are approved once at arm time instead (one permission
   ask, written to the audit chain as a `contract_approval` line, granted or not); a run then only
   honors explicit deny rules (a deny-only permission probe). If the arm-time approval is not
   granted the contract is not armed.
3. Each run records exit code, a deterministic output hash and a log file. With
   `HORDECODE_PERMISSION_AUDIT=1` each run is also a `contract_evidence` line in the hash-chained
   permission log (`horde debug audit-verify` verifies the chain).
4. The test files are re-hashed. A modified, deleted or added test file ends the contract as `failed`,
   even when every criterion passes.
5. A failing criterion injects a synthetic user turn naming the command, the exit code and the output
   tail, and the loop continues. After 3 re-entries the contract becomes `blocked`, never `verified`.
6. If permission for a criterion is not granted the contract becomes `unverified`.
7. Optional, OFF by default (constants below): a safety envelope with a wall-time, tool-call and USD
   cap, and a git checkpoint at arm time. See "Opt-in constants".

Final states: `verified`, `failed` (test integrity), `blocked` (re-entries exhausted or an envelope
cap breached), `unverified` (could not judge). With no contract armed nothing changes.

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

Overnight: with the attended default, a criterion that is not already allowed by a rule waits for a
human reply (5 minute bound) and then the contract is `unverified`. Arm with `;; unattended` while
you are present, or allow the commands with a `bash` permission rule.

## Opt-in constants (all default OFF)

Keys in `CONTRACT_DECISIONS` (`packages/task/src/contract-decisions.ts`); 0 or false = off.

| Key | Default | Effect when set |
|---|---|---|
| `maxWallMs` | 0 | Wall time since arm. |
| `maxToolCalls` | 0 | Tool parts of assistant messages since arm. |
| `maxCostUsd` | 0 | Sum of the per-step `cost` stored on the assistant messages since arm (the advisor cost is already added to that message). |
| `checkpointRef` | false | At arm time `git update-ref refs/hordecode/contract/<session> HEAD`: a lightweight ref, never a commit or stash, no change to branch, index or working tree. The sha is in the report. Skipped with a reason outside a git repo, with no commit at HEAD, or for an unsafe session id. |
| `unattended` | false | Default of the per-contract `unattended` flag. |

Envelope behavior: the caps are copied into the contract at arm time. They are checked once per
loop iteration (before the model call) and again at the stop gate before any criterion runs, so an
over-budget run cannot verify. A breach ends the contract as `blocked`, adds an evidence row
(`envelope:<cap>`, limit and observed value, hash of the breach record), writes a `contract_evidence`
audit line and the report, and ends the loop. It does not interrupt a step already in flight.

## Where the code is

| File | Class | Content |
|---|---|---|
| `packages/task/src/contract.ts` | FORK_ONLY (new) | schema, in-memory store, `/contract` parser, re-entry text |
| `packages/task/src/contract-decisions.ts` | FORK_ONLY (new) | one constant per open decision |
| `packages/opencode/src/session/contract/{runner,integrity,report,gate,command,envelope,checkpoint}.ts` | FORK_ONLY (new) | runner, integrity check, report writer, stop gate and envelope gate, command handler, caps, git checkpoint |
| `packages/task/src/index.ts` | FORK_ONLY | two export lines |
| `packages/opencode/src/session/prompt.ts` | FORK_DELTA | 2 imports, 1 gate construction, 1 envelope line per loop iteration, 2 stop-gate lines (after `Goal.runGate`, both stop sites), 1 `/contract` hook. Every hunk carries a one-line citation of the opencode v1.19.5 `session/prompt.ts` line it sits at (1088, 1098, 1128, 1334, 1370-1372, imports 27-35) |
| `packages/opencode/src/command/index.ts` | FORK_DELTA | command id `CONTRACT` (upstream `command/index.ts:46-49`) and its registration (upstream `:79-89`) |

`permission/audit.ts` is not edited: `PermissionAudit.write` already takes any entry kind and
`verify` does not look at `kind`, so the design note's "one new entry kind" needed no change there.

## OPEN DECISIONS (owner's; conservative option picked)

Each is a key in `CONTRACT_DECISIONS` (`packages/task/src/contract-decisions.ts`) unless stated.

| # | Choice made | Flip |
|---|---|---|
| 1 Storage | Session-only record in process memory: not agent-editable, no repo file, no DB migration. Lost on process exit (the report on disk survives). | `storage`. Only "session" is implemented; a registry-row or repo-file backend needs code. |
| 2 Where criteria run | The session working directory. | `criteriaCwd`. Only this value is implemented; a worktree/sandbox needs code. |
| 3 Permission | Attended: ask on each run through the permission system. Unattended is a per-contract flag (`;; unattended`), default OFF: one ask at arm time, audited, deny rules still apply. | `unattended` (default of the flag). |
| 4 Verifier | Not in this slice (deferred by the note). No code, no model call. | n/a |
| 5 Protected set | Every test file in the project plus named paths; a new test file is a violation; criterion command files are NOT hashed (residual hole stays open). | `protect: "named-only"`, `allowAddedTests: true`. |
| 6 Caps | Re-entry cap 3 and a 120 s per-criterion timeout (a timeout is a failed criterion). Wall, tool-call and USD caps exist but are OFF (0); a breach stops the run as `blocked` (not parked resumable). No token cap. | `maxReact`, `criterionTimeoutMs`, `maxWallMs`, `maxToolCalls`, `maxCostUsd`. |
| 7 Gate placement | Beside the existing gates, after task gate and goal gate, so criteria run once when the others agree to stop. The three existing gates are untouched. | Structural (the order of two lines in `prompt.ts`), not a constant. |
| 8 Git checkpoint | A lightweight ref at arm time, one per contract (not per step), default OFF; never a commit, stash or worktree. | `checkpointRef`. |
| 9 Notification | File only, outside the project tree. | `reportDir` (name under the data dir). |
| 10 Mode/agent edit | Invisible, always available as `/contract`. The agent has no tool that writes a contract; only the user-typed command does. Re-arming while active is refused until `/contract clear`. | n/a |

Also decided, not numbered in the note: integrity violation ends the contract as `failed` at once
(`onIntegrityViolation: "reenter"` turns it into a re-entry like a failed criterion).

## Verification (measured)

Numbers from the last full run on this branch (head after the step 2-4 commit; see
`reports/rnd/rnd-task-contract-slice1.md` for the commands).

- `packages/task`: `bun test` 27 pass, 0 fail (13 new in `test/contract.test.ts`); `bun run typecheck` clean.
- `packages/opencode`: `bun run typecheck` clean (needs `NODE_OPTIONS=--max-old-space-size=12000`).
- `bun test test/session/contract` in `packages/opencode`: 50 pass, 0 fail across runner (7), integrity (10),
  report (6), envelope (6), checkpoint (5) and session-level `contract-turn` (16) tests. Session-level cases:
  fail then pass then verified; re-entry cap then blocked; changed test file fails; denied permission is
  unverified; child session not gated; `/contract` end to end; no contract means one turn and no store entry;
  wall, tool-call and USD caps each end the contract as blocked with breach evidence; checkpoint OFF creates
  no ref, ON creates `refs/hordecode/contract/<session>` at HEAD and reports the sha; attended asks per run
  (2 asks for 2 runs), unattended asks once (1 ask, 1 audited approval, audit chain verifies), a denied
  arm-time approval arms nothing, an explicit deny rule still stops an unattended run.
- Wider run, `bun test test/cli/help test/session test/permission test/command test/task`: 859 pass, 24 fail
  (892 tests, 91 files). The 24 are the same checkpoint-writer, rebuild, drain, interrupt-scope and
  task-binding tests that fail on the unmodified tree (earlier clean-tree run of `test/cli/help test/session`:
  592 pass, 24 fail); none is a contract test. Their files pass in isolation. Core `goal.test.ts`: 10 pass.
- One session test (the first in `contract-turn.test.ts`) timed out once at the 5 s default on a cold start in
  one run and passed in the next two runs of the same file; treated as a cold-start flake, not a product signal.

## Not done / evidence gaps

- FORK_DELTA citations are checked against a clone of opencode v1.19.5 (`../repos/opencode-1.19.5`); the lines
  cited are the upstream lines the hunks sit at, since upstream has no counterpart code for them.
- The map was regenerated with `bun run script/upstream-map.ts --base v1.17.18 --ref ../repos/opencode-1.19.5`.
  The repo is a shallow clone without the `v1.17.18` tag, so a local tag was created on `b1fc81139` (its sha
  equals the upstream tag sha per `git ls-remote`); it is not pushed. The regeneration also added rows for
  files from earlier work that the committed map did not have yet, not only this slice.
- Not run on the installed binary (FORK-RULES section 7 asks for it before a release); covered by the
  fake-LLM session tests only.
- Evidence log files keep the redacted output tail only (16 KiB); the hash covers the full output.
- The store is per process: a restart loses the armed contract (decision 1).
- The envelope cannot interrupt a model step or tool call in flight; it is checked between steps and at stop.
- Token caps and notification delivery are not implemented.
