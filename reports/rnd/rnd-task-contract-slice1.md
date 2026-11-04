# Report: rnd/task-contract-slice1

Scope: task contract first slice prototype, then the follow-up brief (upstream citations, safety
envelope, git checkpoint, unattended flag). Usage and the open-decision table are in
`docs/task-contract-slice1.md`; this file records what was done and measured.

## Commits (in order, on top of v0.1.5 = 094f510aa6)

| Commit | Content |
|---|---|
| f73c51201 | Round 1: contract first slice (store, runner, integrity check, re-entry loop, report, `/contract`) |
| d98f688fd | Round 2: FORK_DELTA citations replaced with opencode v1.19.5 file:line |
| 6d01949ac | Round 2: ownership map regenerated against opencode 1.19.5 |
| f8dd6dbdc | Round 2: safety envelope, git checkpoint, unattended flag, docs, this report |
| cb2425f67 | Round 2: ownership map regenerated for the envelope files |
| 24e1ae5a7 | Round 3: review findings F1 to F4 (code and tests) |
| 00e00e0b5 | Round 3: docs and report |
| (none) | Round 3: ownership map regenerated against v1.19.5: empty diff (no new files, classes unchanged), nothing to commit |
| b0f3bb62c | Round 3: shas recorded in the report |
| f991254e6 | Round 4: `contract` config block (schema) |
| 16d166dbe | Round 4: SDK types regenerated with the generator |
| 1a7663d15 | Round 4: findings F1 to F8 (code and tests) |
| DOCS_SHA | Round 4: docs and report |
| MAP_SHA | Round 4: ownership map regenerated (separate commit) |

## Observation, root cause, action, evidence

1. Citations. Observation: hunks cited local prompt.ts lines because no upstream checkout existed. Action:
   cloned v1.19.5 (`git describe` = v1.19.5, `packages/opencode/package.json` version 1.19.5) and cited the
   upstream lines each hunk sits at: `session/prompt.ts` 27-35 (imports), 1088 (before the loop), 1098 (after
   the lastUser check), 1128 and 1334 (the two stop sites), 1370-1372 (command hook); `command/index.ts` 46-49
   (Default) and 79-89 (registration). Evidence: `git diff` of d98f688fd touches comment lines only.
2. Map. Observation: `v1.17.18` was not a tag in this shallow clone. Action: local tag on `b1fc81139`, whose
   sha equals the upstream tag (`git ls-remote` on the upstream clone). Result:
   PARITY=4933 LAGGING=55 FORK_DELTA=899 FORK_ONLY=1325 FORK_KEPT_UPSTREAM_REMOVED=11 UPSTREAM_ONLY=30.
   FORK_DELTA and PARITY did not change, so no upstream file was reclassified; 54 FORK_ONLY rows were added,
   8 of them from this slice and the rest from earlier work the committed map had not caught up with.
3. Envelope. Caps (`maxWallMs`, `maxToolCalls`, `maxCostUsd`, 0 = off) are copied into the contract at arm
   time. A per-iteration check (one new line in `prompt.ts`) and the stop gate evaluate them; a breach ends the
   contract as `blocked` and adds breach evidence, an audit line and a report. Defaults off: the `arm` test
   asserts the envelope is only `{max_react: 3}`, and the pre-existing session tests (fail then pass, no
   contract) run with defaults.
4. Git checkpoint. `refs/hordecode/contract/<session>` via `git update-ref`, default OFF. Tests assert HEAD,
   branch, commit count, status and stash are unchanged, the ref stays at the arm-time sha after the branch
   moves, and non-repo, no-commit and unsafe-id cases are skipped with a reason.
5. Unattended. Per-contract flag (`;; unattended`), default OFF. Approval is one permission ask at arm time
   plus a `contract_approval` audit line (granted or not); runs probe deny rules only. Test: attended = 2 asks
   for 2 runs, unattended = 1 ask, 1 approval line, `PermissionAudit.verify().ok` true.

## Measured

| Check | Result |
|---|---|
| `packages/task` `bun test` | 27 pass, 0 fail |
| `packages/task` typecheck | clean |
| `packages/opencode` typecheck (`NODE_OPTIONS=--max-old-space-size=12000`) | clean |
| `packages/opencode` `bun test test/session/contract` | 50 pass, 0 fail |
| `bun test test/cli/help test/session test/permission test/command test/task` | 859 pass, 24 fail, 892 tests, 91 files |
| Same 24 on the unmodified tree | yes, same test families (earlier clean run of `test/cli/help test/session`: 592 pass, 24 fail) |
| `packages/core` `goal.test.ts` | 10 pass |

The 24 failures are checkpoint writer, rebuild, drain, interrupt-scope and task-binding tests, none from
this slice; their files pass in isolation. One cold-start timeout in the first contract session test
occurred once and did not reproduce in two further runs.

## OPEN DECISIONS (unchanged picks, see the doc for the full table)

3 attended by default, unattended per contract; 6 caps exist but OFF, breach stops as blocked (not parked);
8 lightweight ref, OFF. Decisions 1, 2, 4, 5, 7, 9, 10 as in the first report.

## Not done

- Not run on the installed binary. Token cap, notification delivery, durable resume: not implemented.
- The envelope cannot interrupt a step in flight.
- The `v1.17.18` tag exists only locally in this checkout.

## Round 3: independent review (origin/rnd/reviews-0.1.6)

Each finding was reproduced with a failing test first, then fixed. Detail table in
`docs/task-contract-slice1.md` ("Review findings (round 3)").

1. F1 (HIGH) permission bypass. Observation: `echo ok ; rm -f marker.txt` with allow `echo ok*` and deny
   `rm *` deleted the marker (test failed on `existsSync(marker)`). Root cause: the whole string was one
   permission pattern. Action: criteria are authorized through the bash tool itself. `tool/shell.ts` gets a
   3-line `authorizeOnly` return after its permission block (upstream `tool/shell.ts:631`); the gate builds a
   `Tool.Context` and calls the registered bash tool's `execute`, so the tool's own tree-sitter split,
   per-sub-command patterns, `external_directory`, protected-path and `bash_delete` asks apply. No second
   parser. Unattended uses the same path with deny-only probes. Evidence: test passes, marker kept, contract
   `unverified`; a compound whose every part is allowed verifies.
2. F2 (HIGH) runner hang. Observation: `setsid sleep 6 & exit 0` with a 500 ms timeout and a same-group
   background child both hung to the 5 s test limit (2 failing tests; the plain timeout test already passed).
   Root cause: waiting for `close`, one timer, no group kill after exit. Action: exit code recorded on `exit`,
   process group killed on exit and on timeout, stdio drain bounded at 1 s, hard 2 s deadline after a
   timeout kill, digest guarded against late data. Evidence: 10 runner tests pass.
3. F3 (MEDIUM) protection gaps. Gitignored `protect:` path (0 files hashed before), symlinks (invisible),
   package.json scripts (unprotected): 5 failing tests, now 16 integrity tests pass. A `protect:` path with no
   files fails arming. The arm-time warning is shown to the user as a synthetic message and the spec still
   runs as the task. A new test file no longer fails the contract (`allowAddedTests` default true); modified
   and deleted protected files still do.
4. F4/F6 switches and mutant. Turn-level tests for the unattended default, `reenter`, `named-only`,
   `allowAddedTests` false, package.json scripts and timeout-as-failure. Mutant "timeout counts as pass":
   1 test fails; mutant "verified when violated": 2 tests fail; both restored afterwards (file diff empty).
5. Citations. All 8 `FORK_DELTA: opencode v1.19.5` comments resolve to the stated upstream lines in the
   v1.19.5 checkout (prompt.ts 27-35, 1088, 1098, 1128, 1334, 1370-1372; command/index.ts 46-49, 79-89;
   shell.ts 631).

## Measured (round 3)

`NODE_OPTIONS=--max-old-space-size=12000`, same commands on base (v0.1.5, separate worktree) and head.

| Command | Base v0.1.5 | Head |
|---|---|---|
| `cd packages/task && bun test` | 14 pass, 0 fail | 29 pass, 0 fail |
| `cd packages/opencode && bun test test/session/contract` | no such test files | 72 pass, 0 fail |
| `cd packages/opencode && bun test test/cli/help test/session test/permission test/command test/task` | 809 pass, 24 fail (842 tests, 85 files) | 881 pass, 24 fail (914 tests, 91 files) |
| typecheck task, opencode | not run | clean, clean |

The 24 failures are the same test names on base and head (sorted lists identical).

## OPEN DECISIONS after round 3

- 5: other runner configs (`conftest.py`, `jest.config.*`, `Makefile`) and scripts named in a criterion are
  not hashed. package.json test scripts are (constant `protectScripts`). `allowAddedTests` now defaults true.
- 3: attended by default; unattended per contract. Unchanged otherwise (1, 2, 4, 6, 7, 8, 9, 10 as before).

## Not done

F5 remainder (a criterion that writes into a protected directory fails the contract), F8 (store leak, `case`
split, server auth), not run on the installed binary, no token cap, no notification delivery, envelope cannot
interrupt a step in flight, a setsid child outlives the runner. The `v1.17.18` tag is local only.

## Round 4: second review (origin/rnd/reviews-0.1.6, review2)

Failing test first for each item; detail table in `docs/task-contract-slice1.md` ("Review findings (round 4)").

1. F1 (HIGH) caps reset at compaction. Observation: with 40 tool calls and $5 recorded before a compaction
   boundary and a 30-call cap, the model was still called (test expected 0 calls, got 1). Root cause: usage was
   summed over `filterCompacted` messages. Action: totals live in the contract record (`usage`), are read from
   the message and part tables and only ever raised (`recordUsage` takes the maximum), so compaction and revert
   do not lower them. Evidence: tool-call and USD tests pass, ledger unit tests pass, mutant "overwrite instead
   of max" fails 2 tests.
2. F4 delegated work. Observation: child and grandchild tool calls (6) and child cost ($3) did not count
   toward caps of 5 calls and $2. Action: one recursive query over the `parent_id` chain; unrelated sessions are
   not counted; with no tool or USD cap nothing is read. Evidence: 3 tests pass; mutant "children ignored"
   fails 2 tests.
3. F2 reachability. `/contract` segments `cap: wall|tools|cost`, `checkpoint`, any-case `unattended`, plus a
   `contract` config block; precedence segment, config, constant; defaults off. Schema and SDK types were
   regenerated with `packages/sdk/js/script/build.ts` (not hand-edited); the JSON schema produced by
   `packages/opencode/script/schema.ts` carries the block with `exclusiveMinimum: 0` on the USD cap.
4. F5 checkpoint. `git -c core.hooksPath=<null device> update-ref`; ref per contract id; a test with a
   `reference-transaction` hook shows no marker; dirty, staged and stashed repository unchanged. The ref still
   pins objects and `git push --mirror` publishes it: OPEN DECISION 8, cleanup commands in the doc.
5. F6, F7, F8. F6: usage read fresh at each call, test calls the stop gate directly, mutant E2 now fails 1
   test. F7: report says when no audit line was written. F8: keyword parsing fixed, dirty-repository fixture
   added. F3 re-check: the round-3 compound-command tests pass and an `external_directory` deny stops a
   criterion that reads outside the project.

## Measured (round 4)

`NODE_OPTIONS=--max-old-space-size=12000`, same commands on base (v0.1.5, separate worktree) and head 1a7663d15.

| Command | Base v0.1.5 | Head | Previous head b0f3bb62c |
|---|---|---|---|
| `cd packages/task && bun test` | 14 pass, 0 fail | 36 pass, 0 fail | 29 pass, 0 fail |
| `cd packages/task && bun run typecheck` | clean | clean | clean |
| `cd packages/opencode && bun test test/session/contract` | no such test files | 86 pass, 0 fail | 72 pass, 0 fail |
| `cd packages/opencode && bun run typecheck` | clean | clean | clean |

The wider opencode set was not re-run this round (last round: 809/24 base, 881/24 head, same 24 tests).

## OPEN DECISIONS after round 4

- 8: the checkpoint ref pins objects and `git push --mirror` publishes it; no automatic deletion.
- 5: other runner configs and scripts named in a criterion are not hashed.
- 3: `unattended` approves the command string once; script content can change afterwards.
- 1: durable storage across restart is deferred.

## Not done

Restart loses the armed contract; wall time includes human wait; `context_from` children not counted; bundled
config reference not updated; token cap, notification delivery, installed-binary run; a setsid child outlives
the runner; round-3 gaps (F5 remainder, F8 store leak and `case` split, server auth) unchanged.
