# Task contract (prototype)

A task contract is how you hand Hordecode a job and walk away: you state the objective and the
commands that prove it is done, and the product (not the agent) runs those commands when the agent
tries to stop. It ends in one of four states and writes a report you can read in the morning.

Status: prototype on branch `rnd/task-contract-slice1`, opt-in, one command: `/contract`. With no
contract armed nothing changes. History, measurements and the findings of each review round are in
`reports/rnd/rnd-task-contract-slice1.md`.

## Quick start

```
/contract Make the parser reject empty input ;; bun test
/contract Fix the build ;; bun run build ;; unattended
/contract Refactor the parser ;; bun test ;; protect: fixtures ;; cap: wall 90m ;; cap: tools 200 ;; cap: cost 2.50 ;; checkpoint
/contract status
/contract clear
```

Segments are separated by a newline or by ` ;; `. The spec text is then sent to the agent as its task.

## Syntax

| Segment | Meaning |
|---|---|
| first segment | the objective (required; it cannot be one of the keywords below) |
| anything else | a criterion command, run through the shell in the session directory (at least one is required) |
| `protect: <path>` | protect this file or directory as well; must exist, stay inside the project and hold a file |
| `cap: wall 30s \| 90m \| 2h` | stop with `blocked` after this much elapsed time since arm |
| `cap: tools <n>` | stop with `blocked` after n tool calls (the session and its child sessions) |
| `cap: cost <usd>` | stop with `blocked` after this much spend (the session and its child sessions) |
| `checkpoint` | write a git ref at HEAD when armed (see "Git checkpoint") |
| `unattended` | approve the criteria once now instead of asking at every run (see "Permissions") |
| `no-baseline` | skip the arm-time test count run (see "Test baseline") |

Keywords and prefixes are case-insensitive. A bad or repeated `cap:` is rejected with a message instead
of armed with a guess. `/contract` alone or `/contract status` prints the state and the report path;
`/contract clear` drops the contract (a contract that is still active must be cleared before arming
another).

## What happens

1. Arming. The product hashes (SHA-256) the protected files (below), optionally writes the checkpoint
   ref, and, unless `no-baseline`, runs each criterion once to record how many tests it ran.
2. The agent works. It knows what it is graded on because the spec is its task.
3. When the agent tries to stop, the product runs each criterion itself. The agent's claims in text do
   not count. Each run records the exit code, a hash of the output, and a log.
4. A criterion fails when it exits non-zero, times out (120 s), or exits 0 but fails the test count check.
5. The protected files are hashed again. A modified or deleted protected file, or a runner config added
   after arming, fails the contract even when every criterion passed.
6. A failing criterion sends the agent a message with the command, the exit code and the output tail and
   the loop continues. After 3 of these the contract is `blocked`.

Final states:

| State | Meaning |
|---|---|
| `verified` | every criterion passed, the test count check held, nothing protected changed |
| `failed` | a protected file or runner config changed (the criteria are not trusted after that) |
| `blocked` | the re-entries ran out, or an envelope cap was breached |
| `unverified` | the product could not judge: permission to run a criterion was not granted |

## The report

Written after every gate run to `<data dir>/contracts/<session id>/report.md` (plus `contract.json` and
one log per run), outside the project tree. It lists the objective, the state and why, each criterion
with its last exit code and run count, the evidence (exit code, duration, output hash, test counts,
log path), the test baseline, the protected-file violations and the added test files, the usage so
far, the git checkpoint, and where the audit lines are. Example:

```
# Contract ctr_1a2b3c4d: BLOCKED because: C2 still failing after 3 re-entries

Objective: Make the parser reject empty input
Re-entries: 3 of 3
Usage since arm (session and child sessions): 142 tool calls, 1.87 USD

## Criteria
| id | state | command | last exit | runs |
| C1 | passed | `bun test` | 0 | 4 |
| C2 | failed | `./scripts/check.sh --strict` | 1 | 4 |

## Evidence
- C2 attempt 4: exit 1, 812 ms, tests 40 run / 38 passed
  output sha256: 9f2c...   log: .../contracts/ses_.../C2-4.log

## Test baseline
C1: 40 tests run, 31 passed at arm time (bun)
C2: no baseline (output is not a recognized test summary)

## Test integrity
Protected files at arm time: 41
Violations: none recorded
Added test files (allowed, not protected): test/new.test.ts
```

With `HORDECODE_PERMISSION_AUDIT=1` each run, each approval and each cap breach is also a line in the
hash-chained permission audit log (`horde debug audit-verify` checks the chain). Without it the report
says so; nothing is written to the chain.

## Defaults

Everything optional is off. Precedence, highest first: the `/contract` segment, the `contract` block in
`hordecode.json` (or `opencode.json`), the constant in `packages/task/src/contract-decisions.ts`.

| Setting | Default | Segment | Config key | Constant |
|---|---|---|---|---|
| wall, tool-call and USD caps | off | `cap:` | `contract.max_wall_ms`, `max_tool_calls`, `max_cost_usd` | `maxWallMs`, `maxToolCalls`, `maxCostUsd` |
| git checkpoint | off | `checkpoint` | `contract.checkpoint` | `checkpointRef` |
| unattended | off | `unattended` | `contract.unattended` | `unattended` |
| arm-time test baseline | on | `no-baseline` | `contract.baseline` | `testBaseline` |
| re-entries before `blocked` | 3 | | | `maxReact` |
| criterion timeout | 120 s | | | `criterionTimeoutMs` |
| protect | all test files, runner configs, test scripts | `protect:` adds paths | | `protect` (`named-only`), `protectScripts`, `protectRunnerConfigs` |
| a new test file after arming | allowed, reported | | | `allowAddedTests` |
| a protected file changed | contract `failed` | | | `onIntegrityViolation` (`reenter` nudges instead) |

## What is protected

With the default `all-test-files` mode these files are hashed at arm time and again at the end:

- Test files: `*.test.*`, `*.spec.*`, files under `test/`, `tests/`, `__tests__/`, `spec/`,
  `test_*.py`, `*_test.go|py|rs|rb|ex|exs`, `*Test(s).java|kt|cs|swift`.
- Runner configs, at any depth: `bunfig.toml`, `jest.config.*`, `vitest.config.*`, `vitest.workspace.*`,
  `pytest.ini`, `conftest.py`, `tox.ini`, `setup.cfg`, `pyproject.toml`, `go.mod`, `Cargo.toml`. One that
  appears after arming is a violation too.
- In every `package.json`: the `test`, `pretest` and `posttest` scripts, their `pre`/`post` hooks, and
  every script they reach through `npm|pnpm|yarn|bun run <name>`. Other scripts and dependencies may change.
- Everything under a `protect:` path, even in a gitignored directory (arming warns about that).
- A symlinked test file is hashed through its link text and target; the files behind a symlinked
  directory are hashed through the link, so retargeting or editing the target is seen.

What it costs: because `pyproject.toml`, `go.mod` and `Cargo.toml` are protected, an agent that
legitimately adds a dependency fails the contract. Flip `protectRunnerConfigs` if that is wrong for
you.

## What is not protected

- Test files in a gitignored directory (in the default mode; name them with `protect:`).
- A new test file. It is allowed and listed in the report, but it is not protected afterwards.
- Runner configs and scripts the criterion calls that are not in the list above (a `Makefile`,
  `scripts/check.sh`, a CI file).
- Other `package.json` scripts, and the content of a script a criterion calls (see "Permissions").
- Anything outside the project tree.

## Test baseline

At arm time each criterion runs once (through the permission check, unless `unattended` already approved
it) and the product reads the runner's own summary: `bun test`, jest, vitest, pytest, `cargo test`, and
`go test -v`. It records the number of tests run and passed. Red at arm time is normal.

At the end a criterion that exits 0 still fails when:

- the output is a summary with 0 tests;
- it ran fewer tests than the baseline;
- the baseline had a summary and the output no longer does. This is what stops an added test file that
  calls `process.exit(0)`.

If the baseline run did not print a recognized summary the report says `no baseline` and only the
0-tests check applies. `go test` without `-v` prints no counts, so it never has a baseline. The jest and
vitest parsers follow their documented summary lines; they were checked against recorded samples, not live
runs, unlike bun, pytest, cargo and go. A baseline run executes your criterion once before the agent starts,
so a slow or side-effecting criterion costs that; use `no-baseline` to skip it.

## Permissions

Criteria run through the same permission system as the agent's bash tool, not around it. Each command is
split into sub-commands, each gets its own `bash` permission check, and `external_directory`, protected-path
and delete (`bash_delete`) confirmations apply, so `bun test ; rm -rf x` is not covered by an allow rule for
`bun test*`. Plugin `tool.execute.before` hooks do not see criterion runs.

- Attended (default): a criterion that is not already allowed by a rule asks at arm time (the baseline run)
  and at every stop, and waits for a reply (5 minutes), then the contract is `unverified`.
- `unattended`: the criteria are approved once, at arm time, while you are there. The list of approved
  commands is stored; an unattended run of any other command is blocked. Runs only honor explicit deny rules.
  If the arm-time approval is not granted nothing is armed. The approval is a `contract_approval` audit line
  when audit is on. The approval covers the command text: a script the command calls can change afterwards,
  and a `careful` session does not re-ask.

## Git checkpoint

`checkpoint` writes `refs/hordecode/contract/<session id>/<contract id>` at HEAD with hooks disabled: no
commit, no stash, no change to the branch, index or working tree (dirty state is not captured, only
HEAD). One ref per contract. It is skipped with a reason outside a git repository or with no commit.

The ref pins its objects against `git gc`, and `git push --mirror` (or a `refs/hordecode/*` refspec)
publishes it; `git push`, `--all` and `--tags` do not. Nothing deletes it for you:

```bash
git for-each-ref refs/hordecode/contract
git update-ref -d refs/hordecode/contract/<session id>/<contract id>
```

## Limits

- The armed contract and its totals live in process memory. A restart loses them (the report on disk stays).
  Compaction, `/undo`, stops and new prompts inside one process do not reset them.
- Caps are checked between steps and at stop; a step already running is not interrupted. Wall time is elapsed
  time and includes waiting for a human reply. Child sessions are found through their parent link only.
- A criterion cannot leave a helper running for the next criterion: the process group is killed when the
  command ends, unless the helper starts a new session (`setsid`), which the runner stops waiting for but
  cannot kill. Put the start of a helper inside the criterion that needs it.
- Criteria run through the same shell wrapper as the bash tool, so `$$`, `$!` and `$(...)` in a criterion
  are expanded by the outer shell first.
- The log of a run keeps the last 16 KiB of redacted output; the hash covers the full output. The count
  parser reads the last 256 KiB; cargo and go counts are not trusted past that.
- A criterion that writes into a protected directory (snapshots, golden files) fails the contract.
- Criteria are split on newline and ` ;; `: a shell `case ... ;; ... esac` needs a script.
- The store is not cleared when a session is deleted. Only the user-typed command arms a contract, and the
  agent has no tool for it; that is as strong as the server authentication.
- No token cap, no notification delivery, no LLM verifier, not run on the installed binary.

## Open decisions

For the owner. The pick shown is what is implemented; "flip" says where.

| # | Question | Implemented | Flip |
|---|---|---|---|
| 1 | Where the record lives | process memory, not agent-editable, lost on restart | needs a backend (registry row or file) |
| 2 | Where criteria run | the session directory | needs code (worktree or sandbox) |
| 3 | Permission for criteria | attended by default; `unattended` approves once at arm time | `unattended` |
| 4 | LLM verifier | not in this slice | n/a |
| 5 | Protected set | test files, runner configs, test scripts; new test file allowed | `protect`, `protectRunnerConfigs`, `protectScripts`, `allowAddedTests` |
| 6 | Caps | re-entries 3, 120 s per criterion; wall, tools, USD off; a breach stops as `blocked`, not parked | `cap:`, `contract.*`, `maxReact` |
| 7 | Gate placement | beside the task and goal gates, after them | two lines in `session/prompt.ts` |
| 8 | Git checkpoint | lightweight ref per contract, off; not deleted automatically, `--mirror` publishes it | `checkpoint`, `contract.checkpoint` |
| 9 | Notification | report file only | `reportDir` |
| 10 | Mode and agent edit | invisible, always available; the agent cannot edit it | n/a |
| 11 | Baseline run at arm time | on; executes each criterion once, may be slow or have side effects | `no-baseline`, `contract.baseline` |
| 12 | Runner configs in the protected set | on; legitimate dependency edits fail the contract | `protectRunnerConfigs` |
| 13 | Integrity violation | `failed` at once | `onIntegrityViolation: "reenter"` |
| 14 | Plugin hooks on criterion runs | not applied | needs the tool wrapper path |
| 15 | Durability across restart | none | with decision 1 |

## For developers

| File | Class | Content |
|---|---|---|
| `packages/task/src/contract.ts`, `contract-decisions.ts` | FORK_ONLY | schema, in-memory store with the usage ledger, `/contract` parser, constants |
| `packages/opencode/src/session/contract/*.ts` | FORK_ONLY | runner, test count parser, integrity, report, gate, command, envelope, usage reader, checkpoint |
| `packages/opencode/src/session/prompt.ts` | FORK_DELTA | imports, gate construction, one envelope line per loop iteration, two stop-gate lines, the `/contract` hook; each hunk cites the opencode v1.19.5 `session/prompt.ts` line it sits at |
| `packages/opencode/src/tool/shell.ts` | FORK_DELTA | three lines before `return yield* run(` (upstream `tool/shell.ts:631`): `authorizeOnly` returns after the permission block without executing |
| `packages/opencode/src/command/index.ts` | FORK_DELTA | command id `CONTRACT` (upstream `:46-49`) and its registration (upstream `:79-89`) |
| `packages/core/src/{v1/,}config/config.ts` | see map | the `contract` config block; SDK types are generated by `packages/sdk/js/script/build.ts` |

`permission/audit.ts` is not edited: `PermissionAudit.write` takes any entry kind and `verify` ignores `kind`.
Tests: `packages/task/test/contract.test.ts` and `packages/opencode/test/session/contract/`.
