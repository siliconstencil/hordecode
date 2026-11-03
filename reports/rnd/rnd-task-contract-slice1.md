# Report: rnd/task-contract-slice1

Scope: task contract first slice prototype, then the follow-up brief (upstream citations, safety
envelope, git checkpoint, unattended flag). Usage and the open-decision table are in
`docs/task-contract-slice1.md`; this file records what was done and measured.

## Commits (in order, on top of v0.1.5 = 094f510aa6)

| Commit | Content |
|---|---|
| f73c51201 | Contract first slice: store, runner, integrity check, re-entry loop, report, `/contract` |
| d98f688fd | FORK_DELTA citations replaced with opencode v1.19.5 file:line |
| 6d01949ac | Ownership map regenerated against opencode 1.19.5 (separate commit) |
| next | Envelope, git checkpoint, unattended flag, tests, docs, this report |
| last | Ownership map regenerated again for the files added by the previous commit |

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
