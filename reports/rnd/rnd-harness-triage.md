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

### Classifier (round 2: conservative by construction)

Review `origin/rnd/reviews-0.1.6:reports/rnd/review-rnd-harness-triage.md` measured 14 of 14 ordinary English
feature requests and 11 of 13 non-English requests as routine. The classifier now defaults to complex; a request
is routine only if ALL of these hold:
| Requirement | Rule |
|---|---|
| shape | matches a short allow-list of mechanical edits: fix a typo/spelling/indentation/whitespace/formatting/unused import/import order, remove unused X, bump the version, add/fix/update/correct a comment/docstring/jsdoc/readme/changelog, reformat, reindent |
| scope | exactly one named file or directory (URLs stripped, repeats counted once) |
| language | at most 5% of the letters are not ASCII; any other language is complex, whatever it names (F2) |
| size | one line, one sentence, at most 300 characters, fewer than 2 list items |
| no plan words | plan, design, architect, roadmap, brainstorm, proposal, rfc, spec, migrate, refactor, rewrite, from scratch, step by step, think through, full pipeline |
| no breadth words | everywhere, across the, entire, whole, every, all the files/tests/callers/usages/modules/packages |
| not compound | and, then, also, plus, as well, too, while you, additionally, etc, similar, related, other(s) |

Plan, breadth and compound words are matched on the request with URLs and paths removed, so `util.spec.ts`,
`docs/plan.md` and a url containing "design" are not signals (F4). The request is the latest user message with a
non-synthetic text part.

The routine section is inserted before the closing `</system-reminder>` of the harness prompt, under the same
authority as the pipeline rules it overrides (F3). Off, a complex verdict and the research agent keep the 0.1.5
text; a test compares them with the base formula.

### What a routine verdict tells the agent
Skip harness:brainstorm, harness:plan, harness:tdd. Implement directly (harness:execute), then harness:verify with
its evidence gate. Do not run review, report, eval or merge unless the user asks. If the work turns out large, say
so and continue with the full sequence from brainstorm.

Sample verdicts (committed classifier):
| Request | Class | Deciding signal |
|---|---|---|
| Fix the typo in src/util/range.ts | routine | mechanical edit "fix the typo", 1 file |
| Bump the version in package.json | routine | mechanical edit |
| Fix the typo in src/util.spec.ts | routine | (spec inside a file name is not a plan word) |
| Add OAuth login to src/auth.ts | complex | not a known mechanical edit |
| Fix the flaky test in test/a.test.ts | complex | not a known mechanical edit |
| Add retry to src/net/client.ts and update test/net/client.test.ts | complex | compound request, 2 files |
| Fix the typo in src/a.ts and add OAuth login | complex | compound request |
| a Chinese or Russian or Turkish (diacritics) request naming src/a.ts | complex | text is not mostly ASCII |
| make the app faster | complex | no file named |

## Evidence
Tests: packages/core/test/session/harness-triage.test.ts (22 tests).
- Classifier: routine shapes; the 17 false routines of the review (feature, investigation, upgrade, restructure,
  compound requests) are complex; an allowed shape plus anything else is complex; each signal is asserted by name
  (empty, length, files, no file, plan, breadth, compound, one line, one sentence, no known shape, list items);
  directories count as paths; URLs and repeats do not add files; words inside file names and URLs are not signals;
  non-English requests (Chinese, Russian, Turkish with diacritics, Japanese, fullwidth Latin, ASCII text with CJK
  tail) are complex with the "not mostly ASCII" signal; ASCII-spelled non-English requests have no known shape.
- Injection (real `applyHarnessInjection`): off, `triage:false`, a complex request and a compound request produce
  exactly the 0.1.5 formula (harness.txt with skills and docs text substituted); a routine request equals the off
  text with the section inserted before the last `</system-reminder>`, and the text still ends with the closing tag;
  research is never triaged; a synthetic message after the request does not change the verdict.
- Mutants (local, reverted): 16 mutants, one per signal, each fails at least one test: empty, length, non-ASCII,
  files max, files zero, plan, breadth, compound, list items, one line, one sentence, shape, url stripping in
  `pathsIn`, directory counting, file-name stripping in prose, url stripping in prose (the last one survived the
  first test set and got its own test: a url containing "design/plan"). The review's three surviving signals
  (directory counting, URL stripping, empty request) and the `migrate` keyword are now covered.

Suites (measured, this branch at `8ad4179`):
| Package | Typecheck | Tests |
|---|---|---|
| core | clean | 1489 pass, 4 skip, 2 fail (base 1467 / 2 fail; +22 new tests; the 2 failures are `util.flock` and `util.effect-flock` "unwritable lock roots", they fail identically on base because the session runs as uid 0) |
| skill | clean | 39 pass, 0 fail (unchanged) |
| sdk | the generator output for `harness.triage` equals the hand edit; the generator's only other diff is `experimental.openTelemetryContent` (drift from 0.1.5, present on base, not committed here) |

## Open decisions
- OPEN DECISION (F1): the allow-list is deliberately tiny. Widening it (rename in one file, add a log line) trades
  savings against the false-routine risk; it should follow a corpus measurement, not a guess.
- OPEN DECISION: what a routine verdict drops. It skips review, report, eval and merge as well as brainstorm, plan
  and tdd. Eval is the only measurement the pipeline records; the conservative alternative is to keep eval.
- OPEN DECISION (F2): a model call for the verdict (language-independent, more accurate) is out of scope for
  "cheap signals"; today every non-English request keeps the full pipeline.
- OPEN DECISION (F6): the classifier looks at the latest user message only; a follow-up ("now do the same for
  b.ts") is classified on its own text, where "same" is unknown scope only through the missing file. The
  `workflow` runtime (`harness.js`) does not read the key.
- Merge note: this branch and rnd/fixes-after-0.1.5 both change `core/src/session/harness-injection.ts` (the other
  rewrote it for the per-session mapping); resolve by keeping that branch's structure and applying the one-line
  `withTriageSection(...)` call to the harness branch of its prompt text.
- Not done: no lab run of the feature (cost/time ratio not re-measured); the upstream map rows for the two new
  files are not added (generated by script/upstream-map.ts with a reference checkout).
