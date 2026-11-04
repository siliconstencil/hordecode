# Task contract, first slice (prototype)

Branch `rnd/task-contract-slice1`. Prototype for the owner to try before deciding. Scope is section 4
of the design note plus three opt-in additions (safety envelope, git checkpoint, unattended flag),
all OFF by default. Still out: the LLM verifier, token enforcement, notification delivery, durable
resume, per-model gating, changes to the three existing gates.

## Usage

Arm a contract in a session with the `/contract` command. Segments are separated by a newline or by
` ;; `. The first segment is the objective (it can not be a keyword). After it: `protect: <path>` names an
extra protected path, `cap: wall <30s|90m|2h>`, `cap: tools <n>` and `cap: cost <usd>` set the envelope
caps, a bare `checkpoint` or `unattended` (any case) sets that flag, every other segment is a criterion
command. A bad or repeated cap is rejected with a message instead of armed with a guess.

```
/contract Make the parser reject empty input ;; bun test ;; ./scripts/check.sh --strict ;; protect: fixtures
/contract Fix the build ;; bun run build ;; unattended
/contract Refactor the parser ;; bun test ;; cap: wall 90m ;; cap: tools 200 ;; cap: cost 2.50 ;; checkpoint
/contract status
/contract clear
```

What happens:

1. Arming hashes (SHA-256) every test file in the project (`*.test.*`, `*.spec.*`, `test/`, `tests/`,
   `__tests__/`, `test_*.py`, `*_test.go`, ...), the `test`/`pretest`/`posttest` scripts of every
   `package.json`, and every file under a `protect:` path. A symlinked test file is hashed through its
   link text and resolved target, so retargeting is detected. A protect path must exist, stay inside the
   project and hold at least one file; it is walked directly, so a gitignored directory is still hashed
   and arming prints a warning. The spec text is then sent to the agent as its task.
2. When the agent tries to stop, the product (not the agent) runs each criterion in the session
   directory. Each command is authorized through the bash tool's own check (`authorizeOnly` switch in
   `tool/shell.ts`): its tree-sitter split into sub-commands, one `bash` permission pattern per
   sub-command, `external_directory`, protected-path and `bash_delete` asks. `bun test ; rm -rf x` is
   asked and denied per part, an allow rule for `bun test*` does not cover the `rm`. The agent's claims
   in text do not count.
   With the `unattended` flag the criteria are approved once at arm time instead (one permission
   ask, written as a `contract_approval` audit line, granted or not, only when `HORDECODE_PERMISSION_AUDIT=1`; the report always records the approval time and says when no line was written); a run then only
   honors explicit deny rules (a deny-only permission probe). If the arm-time approval is not
   granted the contract is not armed.
3. Each run records exit code, a deterministic output hash and a log file. With
   `HORDECODE_PERMISSION_AUDIT=1` each run is also a `contract_evidence` line in the hash-chained
   permission log (`horde debug audit-verify` verifies the chain).
4. The protected files are re-hashed. A modified or deleted protected file ends the contract as `failed`,
   even when every criterion passes. A new test file is ignored (and is not protected afterwards).
5. A failing criterion injects a synthetic user turn naming the command, the exit code and the output
   tail, and the loop continues. After 3 re-entries the contract becomes `blocked`, never `verified`.
6. If permission for a criterion is not granted the contract becomes `unverified`.
7. Optional, OFF by default: a safety envelope with a wall-time, tool-call and USD cap, and a git
   checkpoint at arm time. Set per contract with the segments above, as defaults in the `contract`
   config block, or (lowest precedence) in the constants. See "Opt-in settings".

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

## Opt-in settings (all default OFF)

Precedence, highest first: the `/contract` segment, the `contract` config block (`hordecode.json`,
`opencode.json`; schema and SDK types are generated from `packages/core/src/v1/config/config.ts`), the
`CONTRACT_DECISIONS` constant (`packages/task/src/contract-decisions.ts`). Nothing is on unless one of
them sets it.

| Setting | Segment | Config key | Constant | Effect |
|---|---|---|---|---|
| Wall time | `cap: wall 90m` | `contract.max_wall_ms` | `maxWallMs` | Elapsed time since arm, including time spent waiting for a human reply or idle between turns. |
| Tool calls | `cap: tools 200` | `contract.max_tool_calls` | `maxToolCalls` | Tool parts of the contract session and every descendant session since arm. |
| USD | `cap: cost 2.50` | `contract.max_cost_usd` | `maxCostUsd` | Sum of the per-step `cost` stored on assistant messages of the session tree since arm (the advisor cost is already in it). |
| Git checkpoint | `checkpoint` | `contract.checkpoint` | `checkpointRef` | See "Git checkpoint". |
| Unattended | `unattended` | `contract.unattended` | `unattended` | Approve the criteria once at arm time; runs honor explicit deny rules only. |

Constants only (no segment or config key): `allowAddedTests` (true; false makes a new test file fail the
contract), `protectScripts` (true), `protect` (`all-test-files`; `named-only` protects only `protect:`
paths), `onIntegrityViolation` (`fail`; `reenter` nudges like a failed criterion, blocked at the cap),
`maxReact`, `criterionTimeoutMs`.

Envelope behavior: the caps are copied into the contract at arm time. The usage totals live in the
contract record (not in the loop): at every loop iteration and again at the stop gate, before any
criterion runs, the product reads the tool-call count and the cost of the session and all descendant
sessions (parent chain: task, supervisor, workflow and peer children) from the message and part tables
since arm and raises the stored totals to at least that reading. Compaction only hides rows from the
model, `/undo` removes them, and a deleted child disappears; none of that lowers the stored totals. With
no tool-call or USD cap the tables are not read. A breach ends the contract as `blocked`, adds an
evidence row (`envelope:<cap>`, limit and observed value, hash of the breach record), writes a
`contract_evidence` audit line and the report, and ends the loop. It does not interrupt a step already in
flight. The record itself is per process: after a restart the armed contract and its totals are gone
(decision 1; durable resume is deferred), but within a running process they survive compaction, stops
and new prompts in the same session.

## Git checkpoint

`refs/hordecode/contract/<session id>/<contract id>` points at HEAD, written with
`git -c core.hooksPath=<null device> update-ref`, so no repository hook runs. It is a lightweight ref:
no commit, no stash, no change to branch, index or working tree (dirty and staged state is not
captured, only HEAD). One ref per contract id, so a second contract in the same session does not
overwrite the first. The sha is in the report. It is skipped with a reason outside a git repository,
with no commit at HEAD, or for an unsafe id.

Risks and cleanup (OPEN DECISION 8): the ref pins its objects against `git gc`, and
`git push --mirror` (or an explicit `refs/hordecode/*` refspec) publishes it; `git push`, `git push --all`
and `git push --tags` do not. Nothing deletes the ref for you. List and delete:

```bash
git for-each-ref refs/hordecode/contract
git update-ref -d refs/hordecode/contract/<session id>/<contract id>
```

## Where the code is

| File | Class | Content |
|---|---|---|
| `packages/task/src/contract.ts` | FORK_ONLY (new) | schema, in-memory store with the usage ledger, `/contract` parser, re-entry text |
| `packages/task/src/contract-decisions.ts` | FORK_ONLY (new) | one constant per open decision |
| `packages/opencode/src/session/contract/{runner,integrity,report,gate,command,envelope,usage,checkpoint}.ts` | FORK_ONLY (new) | runner, integrity check, report writer, stop gate and envelope gate, command handler, caps, usage reader, git checkpoint |
| `packages/core/src/{v1/,}config/config.ts` | upstream-owned, see map | `contract` config block (schema; SDK types regenerated by `packages/sdk/js/script/build.ts`) |
| `packages/task/src/index.ts` | FORK_ONLY | two export lines |
| `packages/opencode/src/session/prompt.ts` | FORK_DELTA | 2 imports, 1 gate construction, 1 envelope line per loop iteration, 2 stop-gate lines (after `Goal.runGate`, both stop sites), 1 `/contract` hook. Every hunk carries a one-line citation of the opencode v1.19.5 `session/prompt.ts` line it sits at (1088, 1098, 1128, 1334, 1370-1372, imports 27-35) |
| `packages/opencode/src/tool/shell.ts` | FORK_DELTA | 3 lines before `return yield* run(` (upstream `tool/shell.ts:631`): `authorizeOnly` returns after the permission block without executing |
| `packages/opencode/src/command/index.ts` | FORK_DELTA | command id `CONTRACT` (upstream `command/index.ts:46-49`) and its registration (upstream `:79-89`) |

`permission/audit.ts` is not edited: `PermissionAudit.write` already takes any entry kind and
`verify` does not look at `kind`, so the design note's "one new entry kind" needed no change there.

## OPEN DECISIONS (owner's; conservative option picked)

Each is a key in `CONTRACT_DECISIONS` (`packages/task/src/contract-decisions.ts`) unless stated.

| # | Choice made | Flip |
|---|---|---|
| 1 Storage | Session-only record in process memory: not agent-editable, no repo file, no DB migration. Lost on process exit (the report on disk survives). | `storage`. Only "session" is implemented; a registry-row or repo-file backend needs code. |
| 2 Where criteria run | The session working directory. | `criteriaCwd`. Only this value is implemented; a worktree/sandbox needs code. |
| 3 Permission | Attended: ask on each run through the bash tool's own per-sub-command check. Unattended is a per-contract flag (`;; unattended`), default OFF: one ask at arm time, audited, deny rules still apply. | `unattended` (default of the flag). |
| 4 Verifier | Not in this slice (deferred by the note). No code, no model call. | n/a |
| 5 Protected set | Every test file, package.json test scripts and named paths; a new test file is ignored; modified or deleted protected files fail. Other runner configs (`conftest.py`, `jest.config.*`, `Makefile`) and scripts named in a criterion are NOT hashed: OPEN DECISION, the residual hole stays. | `protect: "named-only"`, `allowAddedTests`, `protectScripts`. |
| 6 Caps | Re-entry cap 3 and a 120 s per-criterion timeout (a timeout is a failed criterion). Wall, tool-call and USD caps exist but are OFF; a breach stops the run as `blocked` (not parked resumable). Caps cover the session tree and survive compaction. No token cap. | `cap:` segments, `contract.*` config keys, `maxReact`, `criterionTimeoutMs`, `maxWallMs`, `maxToolCalls`, `maxCostUsd`. |
| 7 Gate placement | Beside the existing gates, after task gate and goal gate, so criteria run once when the others agree to stop. The three existing gates are untouched. | Structural (the order of two lines in `prompt.ts`), not a constant. |
| 8 Git checkpoint | A lightweight ref at arm time, one per contract id (not per step), default OFF, hooks disabled; never a commit, stash or worktree. Not deleted automatically; `git push --mirror` would publish it (see "Git checkpoint"). | `checkpoint` segment, `contract.checkpoint`, `checkpointRef`. |
| 9 Notification | File only, outside the project tree. | `reportDir` (name under the data dir). |
| 10 Mode/agent edit | Invisible, always available as `/contract`. The agent has no tool that writes a contract; only the user-typed command does. Re-arming while active is refused until `/contract clear`. | n/a |

Also decided, not numbered in the note: integrity violation ends the contract as `failed` at once
(`onIntegrityViolation: "reenter"` turns it into a re-entry like a failed criterion).

## Review findings (round 3)

Independent review `reports/rnd/review-rnd-task-contract-slice1.md` on `origin/rnd/reviews-0.1.6`. Each
finding was reproduced with a failing test before the fix.

| Finding | Reproduction (before) | Fix | Test now |
|---|---|---|---|
| F1 compound command bypassed a wildcard allow rule | `echo ok ; rm -f marker.txt` with allow `echo ok*`, deny `rm *`: the marker was deleted | authorize through the bash tool (`authorizeOnly`), per sub-command | marker kept, criterion `blocked`, contract `unverified`; a fully allowed compound still verifies |
| F2 runner hang | `setsid sleep 6 & exit 0`, 500 ms timeout: test timed out at 5 s; a same-group child kept the pipes open | exit code taken on `exit`, group killed on exit and timeout, 1 s bounded drain, 2 s kill deadline | 10 runner tests: background child exit 0 in under 3 s, group child killed, real timeout still `timed_out` |
| F3 protection gaps | gitignored `protect:` path hashed 0 files; symlink swap and retarget invisible; package.json scripts unprotected | named paths walked directly + warning + empty path fails; symlinks hashed through the target; scripts hashed; new test file allowed | 16 integrity tests, turn-level warning, empty path, scripts and added-file tests |
| F4/F6 untested switches, surviving mutant | timeout counted as a pass: 28 tests passed | turn-level tests for `unattended` default, `reenter` (restore verifies, never restored blocks), `named-only`, `allowAddedTests`, timeout | mutant "timeout is a pass" now fails 1 test; mutant "verified when violated" fails 2 |
| F5 defaults | new test file failed the contract | `allowAddedTests` default true | see above |
| F7 stale citations | cited local lines | cited upstream v1.19.5 lines (round 2), all re-checked in round 3 against the checkout, including the new `shell.ts` hunk | n/a |
| F8 store leak, `case ;;` split, server auth | not changed | OPEN, see gaps | n/a |

## Review findings (round 4)

Second independent review `reports/rnd/review2-rnd-task-contract-slice1.md` on `origin/rnd/reviews-0.1.6`.
Failing test first for each item.

| Finding | Reproduction (before) | Fix | Test now |
|---|---|---|---|
| F1 HIGH caps reset at compaction | history with 40 tool calls and $5 before a compaction boundary, cap 30 calls: the model was still called | totals live in the contract record, read from the message and part tables (compaction hides rows from the model only), and only ever raised | breach at observed 40 with 0 model calls; same for a $4 USD cap; ledger never lowers (unit) |
| F4 delegated work outside the caps | child and grandchild sessions with 6 tool calls, cap 5: the model was still called | recursive read over the parent chain | child plus grandchild counted (6 of 5); child cost counted ($3 of $2); an unrelated session ignored; with no cap the tables are not read |
| F2 not reachable | caps and checkpoint only settable under test | `cap:` / `checkpoint` / any-case `unattended` segments and a `contract` config block (schema, SDK types regenerated with `packages/sdk/js/script/build.ts`); defaults off | segments set all three; config supplies defaults, a segment overrides; no segment, no config: nothing on |
| F5 checkpoint | a `reference-transaction` hook ran; a second contract overwrote the ref | `core.hooksPath` at the null device; ref per contract id; cleanup and `--mirror` risk documented (OPEN DECISION 8) | hook leaves no marker; two contracts, two refs; dirty, staged and stashed repository untouched |
| F3 (round 3, re-check) | n/a | holds | round-3 compound test still passes; `external_directory` deny now stops a criterion that reads `/etc/passwd` |
| F6 stale stop-site data, mutant E2 | stop-site `enforce` removed: all tests passed | usage read fresh at every call; test calls the stop gate directly | mutant E2 now fails 1 test |
| F7 audit only when enabled | n/a | report states when no `contract_approval` line was written; doc wording corrected | report test |
| F8 parse edges, checkpoint fixture | `Unattended` became a criterion; clean-repo fixture | keywords case-insensitive, keyword or prefix as the first segment rejected, dirty-repository fixture | parser and checkpoint tests |

Mutants applied to the new code and restored afterwards: stop-site enforce removed (1 test fails), usage ignores
children (2 fail), ledger overwrites instead of taking the maximum (2 fail).

## Verification (measured)

All with `NODE_OPTIONS=--max-old-space-size=12000`. Base is `094f510aa6` (v0.1.5) in a separate worktree with
its own `bun install`; head is `1a7663d15` (code and tests of round 4). Same commands in both.

| Command | Base v0.1.5 | Head 1a7663d15 | Previous head b0f3bb62c (last round) |
|---|---|---|---|
| `cd packages/task && bun test` | 14 pass, 0 fail | 36 pass, 0 fail | 29 pass, 0 fail |
| `cd packages/task && bun run typecheck` | clean | clean | clean |
| `cd packages/opencode && bun test test/session/contract` | no such test files | 86 pass, 0 fail | 72 pass, 0 fail |
| `cd packages/opencode && bun run typecheck` | clean | clean | clean |

The wider set (`test/cli/help test/session test/permission test/command test/task`) was not re-run this
round; last round: base 809 pass / 24 fail, head 881 pass / 24 fail, the same 24 tests on both.

## Not done / evidence gaps

- Process restart still loses the armed contract and its totals (decision 1, durable resume deferred); the
  totals survive compaction, revert, stops and new prompts inside one process.
- Wall time is elapsed time: it includes waiting for a human reply and idle time between turns.
- Child sessions are found through `parent_id`. A session linked only through `context_from` is not counted.
- `unattended`: the approval is for the command string; the content of a script it calls can change after
  approval, and a `careful` session that would re-ask each run does not (deny-only probes). This is the cost
  of not asking at every run.
- `git push --mirror` publishes the checkpoint ref; nothing deletes it (OPEN DECISION 8).
- The bundled skill reference `packages/skill/src/builtin/.bundle/hordecode/reference/config.md` does not list
  the `contract` block yet.
- `types.gen.ts` regeneration also picked up one pre-existing line (`openTelemetryContent`) that was missing
  from the committed file; it is generator output, not a hand edit.
- F5 remainder from round 3: a criterion that writes into a protected directory still fails the contract.
- Runner configs other than package.json scripts are not protected (decision 5).
- Store never cleared on session delete; `case ... ;; ... esac` criteria need one criterion per line or a
  script; the guarantee that the agent cannot arm a contract is as strong as the server auth.
- A daemonized child that leaves the process group outlives the runner. Evidence logs keep a 16 KiB redacted
  tail; the hash covers the full output. Not run on the installed binary (FORK-RULES section 7).
- Token cap and notification delivery are not implemented; the envelope cannot interrupt a step in flight.
