# rnd/harness-triage -- request triage for the Harness agent (default off)

Base: 094f510aa6 (v0.1.5). Branch: rnd/harness-triage.

## Observation
Lab evidence (given in the brief): on 5 routine tasks Harness solved the same as Build (15/15) at about 19x the
cost and 9x the wall time. MiMo Code v0.1.11 marks compose deprecated for strong models
(mimocode-v0.1.11 commit 192938ef, packages/opencode/src/agent/agent.ts:215: "Compose mode (deprecated) ... For
Fable/Sol-class models, use Build"). MiMo has no per-request triage; this is Hordecode's own design.

## Root cause
The harness prompt (core/src/session/prompt/harness.txt) makes the full sequence mandatory for every code request:
brainstorm, plan, tdd, execute, verify, review, report, eval, merge. Nothing distinguishes a one-file fix from a
feature.

## Action
- New key `harness.triage` (boolean, default false) in core/src/config/harness.ts (FORK_ONLY; it flows into the
  core and v1 config through the existing `harness` field, no edit to the FORK_DELTA config file).
- New pure module core/src/session/harness-triage.ts (FORK_ONLY): `classifyRequest`, `requestText`,
  `triageSection`.
- One hook in core/src/session/harness-injection.ts (FORK_ONLY, mounted at runtime by
  opencode/src/session/prompt.ts:2011): when `pipeline === "harness"` and `harness.triage === true`, the injected
  text gets the triage section appended. Off, or a complex verdict, returns the text unchanged.
- Hand edits for surfaces that mirror the schema: sdk types.gen.ts `harness.triage` (FORK_DELTA, generated; no
  generator was run) and the builtin config reference row.
- No skill file is changed. The section lives in the injected prompt, so the skills keep their content.

### Classifier (cheap signals, no model call)
Complex if ANY holds; routine only if none does (doubt resolves to complex, because routine removes stages):
| Signal | Rule |
|---|---|
| empty request | complex |
| length | more than 600 characters |
| files named | more than 3 distinct file or directory paths (URLs stripped, repeats counted once) |
| explicit plan request | plan, design, architect, roadmap, brainstorm, proposal, rfc, spec, migrate, refactor, rewrite, from scratch, step by step, think through, full pipeline |
| breadth word | everywhere, across the, entire, whole, every, all the files/tests/callers/usages/modules/packages |
| list | 3 or more numbered or bulleted lines |
| unknown scope | no file named and no code reference (backticks, camelCase, snake_case, `f()`) |

The request is the latest user message with a non-synthetic text part, so reminders and gate re-entries injected
after it do not change the verdict.

### What a routine verdict tells the agent
Skip harness:brainstorm, harness:plan, harness:tdd. Implement directly (harness:execute), then harness:verify with
its evidence gate. Do not run review, report, eval or merge unless the user asks. If the work turns out large, say
so and continue with the full sequence from brainstorm.

Sample verdicts (measured with the committed classifier):
| Request | Class | Deciding signal |
|---|---|---|
| Fix the off-by-one in src/util/range.ts | routine | none |
| Add a --json flag to the `list` command in cli/list.ts | routine | none |
| Why does loadConfig return undefined when the file is empty? | routine | code reference, 0 files |
| fix the typo in README.md | routine | none |
| Add retry to src/net/client.ts and update test/net/client.test.ts | routine | 2 files |
| make the app faster | complex | no file or code reference |
| Plan the migration of the session store to sqlite | complex | plan request |
| Update a.ts, b.ts, c.ts and d.ts to the new logger | complex | 4 files |
| Implement OAuth login: 1. add routes 2. add token store 3. add tests | complex | no file or code reference |
| Rename parseHeader to readHeader everywhere in packages/core/src/ | complex | breadth word (routine before the breadth signal was added) |

## Evidence
Tests: packages/core/test/session/harness-triage.test.ts (21 tests).
- Classifier: routine and complex cases per signal, repeated file and URL handling, parameterised limits.
- `requestText`: last real user message, synthetic and ignored parts skipped.
- Injection (the real `applyHarnessInjection`): off means unchanged -- missing, `{}`, `triage:false` and an
  unrelated harness key give byte-identical prompts with no triage text; on + routine = off text + section exactly;
  on + complex = unchanged; the research agent is never triaged; a synthetic message after the request does not
  change the verdict.
- Mutation check (local, reverted): triage on by default -> 2 tests fail; hook not limited to the harness
  pipeline -> research test fails; "unknown scope" signal removed -> 4 tests fail.

Suites (measured):
| Package | Typecheck | Tests |
|---|---|---|
| core | clean | 1488 pass, 4 skip, 2 fail (base 1467 / 2 fail; +21 new tests; the 2 failures are util.flock and util.effect-flock "unwritable lock roots", they fail identically on base because the session runs as uid 0) |
| skill | clean | 39 pass, 0 fail (unchanged) |
| opencode | clean (NODE_OPTIONS=--max-old-space-size=8192) | test/session/mode-identity.test.ts 5 pass, 0 fail; test/config 256 pass, 1 fail ("continues loading tui config when legacy source cannot be stripped"), identical on base 094f510aa6 (256 / 1) |

## Open decisions
- OPEN DECISION: thresholds (600 chars, 3 files, 3 list items) are guesses from the lab's five tasks, not measured
  on a corpus. They are constants (`DEFAULT_TRIAGE_LIMITS`), not config, to keep the surface to one key.
- OPEN DECISION: what a routine verdict drops. This branch skips review, report, eval and merge as well as
  brainstorm, plan and tdd (the brief names execute + verify). Eval is the only measurement the pipeline records;
  skipping it loses that data for routine runs. The conservative alternative is to keep eval.
- OPEN DECISION: signals are English-only (plan words, breadth words). A non-English plan request that is short
  and names one file is classified routine.
- OPEN DECISION: inline lists ("1. a 2. b 3. c" on one line) are not counted; the unknown-scope signal usually
  catches them, but not when a file is named.
- OPEN DECISION: the classifier looks at the latest user message only, not at the conversation. A short follow-up
  ("now do the same for b.ts") after a complex first request is classified on its own.
- Not done: no lab run of the feature (cost/time ratio not re-measured), no sdk regeneration, the upstream map
  rows for the two new files are not added (the map is generated by script/upstream-map.ts with a reference
  checkout).
