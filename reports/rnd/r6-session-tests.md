# rnd/r6-session-tests

Base: `origin/main` at `094f510aa6` (v0.1.5). Input: `reports/xray/session-features.md`
(`rnd/xray-session`). Session ended on a credit limit; this covers items 1 and 2 of the slice.
Items 3-6 were not started.

## Commits

| Commit | What |
|---|---|
| `12661f4` | test(opencode): drive the advisor hook through the real session loop |
| `80b7f2a` | test(core): drive Goal.runGate through the real Goal.layer |
| `9d671dc` | fix(core): make Goal.runGate actually fail open on a judge failure |

Head: `9d671dc`.

## Item 1: advisor call from the loop (DONE)

Observation (from the X-ray report, re-checked): `session/advisor/hook.ts`'s `maybeAdvise` is
called once per step from `opencode/src/session/prompt.ts:1877`. Every existing advisor test
(72 of them) calls `maybeAdvise` or its collaborators (`evaluate`, `advise`, `collectFacts`, ...)
directly; none drives the real `SessionPrompt` loop. Removing the call site left the whole
72-test advisor suite green.

Action: `packages/opencode/test/session/advisor-loop-turn.test.ts`, three tests, using the same
fake-LLM loop harness as `dsml-retry-turn.test.ts`:
- Three failing `bash` calls trip the `tool_failures` trigger (threshold 3); the advisor's own
  HTTP call is told apart from the main agent's calls by a stable substring of its system prompt
  (`senior reviewer watching a coding agent`, from `session/advisor/run.ts`'s `ADVISOR_SYSTEM`),
  matched with the scripted server's `textMatch`. The admitted note is asserted on the persisted
  display part (`metadata.advisor`); the reminder text (not persisted -- it is pushed onto the
  in-memory messages array for the next step only) is asserted on the next request body sent to
  the model.
- No advisor call below the threshold.
- No advisor call when `experimental.advisor` is absent (default off).

Evidence (measured):
- `cd packages/opencode && bun test test/session/advisor-loop-turn.test.ts` -> 3 pass, 0 fail.
- Revert check: removing the `Advisor.maybeAdvise` call site in `prompt.ts` (replaced with
  `undefined`) -> this file's first test fails (2 pass, 1 fail); the existing 72-test advisor
  suite (`test/session/advisor`) is unaffected (74 pass, 1 fail when run together with this new
  file under the same path prefix, i.e. the 72 old tests still all pass). Restoring the call site
  returns this file to 3 pass, 0 fail.
- `cd packages/opencode && NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` -> clean.

No open decisions for this item.

## Item 2: /goal (DONE)

Observation (re-checked): `core/src/session/__tests__/goal.test.ts` only exercises the Goal state
machine (`set`/`get`/`clear`/`bumpReact`) against a hand-rolled `FakeGoal`, plus the `Verdict` zod
schema. `Goal.runGate` -- the actual stop-condition gate wired into both `opencode/src/session/
prompt.ts` and `core/src/session/prompt.ts` -- had no test at all.

Action: `packages/core/src/session/__tests__/goal-gate.test.ts`, 9 tests, against the real
`Goal.layer` (its in-memory `InstanceState` map and its `MAX_GOAL_REACT` cap), a fake
`LanguageModelV3` standing in for the judge model (`doGenerate` returns the scripted verdict JSON,
no HTTP server needed since `provider.getLanguage` is faked directly), and a fake `Session.Service`
recording `updateMessage`/`updatePart` calls:
- no active goal -> `false`, judge never called;
- satisfied (`ok: true`) -> `false`, goal cleared, no reentry message;
- impossible -> same as satisfied;
- not satisfied -> `true`, reentry user message + text part carrying the judge's `reason`, react
  count incremented;
- judge failure -> fails open (`false`, goal cleared, no reentry) -- see the fix below;
- no model on the turn -> `false`, judge never called, goal left active;
- a subagent turn (`agentID` set) -> never gates;
- the `MAX_GOAL_REACT` cap (now exported from `goal.ts`; it was an unexported constant) -> the
  13th not-satisfied call allows the stop and clears the goal.

Also, as asked ("document current restart behavior... with a test"): a goal set under one build
of `Goal.layer` is invisible to a second, separate `Effect.runPromise` build of the same layer --
`InstanceState.make` backs a plain in-memory `Map`, no disk or database write anywhere in
`Goal.layer`. (First attempt nested the two builds under one `Effect.runPromise`/`Effect.provide`;
Effect memoizes a layer's build by object identity within a single run, so that nesting shared the
same `Goal.Service` instance across the "two" builds and made the test backwards. Fixed to two
genuinely separate top-level `Effect.runPromise` calls.)

OPEN DECISION: whether Goal state should persist across a restart (and if so, how) is a product
decision, not resolved here; the test only documents today's behavior.

### Real defect found and fixed

`runGate`'s own comment says it "fail[s] open on any judge error so a flaky judge can never trap
the user." `evaluate()`'s two call sites wrap `generateObject`/`streamObject` in `Effect.promise`
(which assumes the promise never rejects) rather than `Effect.tryPromise`. A rejected promise --
the only way a real provider/judge failure actually surfaces -- becomes an Effect **defect**
(an uncatchable die), not a typed failure. `runGate` wrapped the `evaluate()` call in
`.pipe(Effect.catch(...))`, which only catches the typed (E) channel; since `evaluate()`'s declared
type is `Effect.Effect<Verdict>` (E = `never`), that catch could never fire for any real judge
failure -- the documented "fail-open" guarantee did not hold for the one case it exists for.

This is inside `core/src/session/goal.ts`, FORK_ONLY (`docs/upstream-map-files.tsv:1309`), and the
fix is unambiguous: `Effect.catch` -> `Effect.catchCause`, with `Cause.squash(cause)` in place of
the plain error for the log line. Landed as two commits per the round's instructions: the
judge-failure test committed red (`test.failing`) in `80b7f2a` alongside the rest of the new file,
then the fix plus flipping that one test back to a plain `test` in `9d671dc`.

Evidence (measured):
- `cd packages/core && bun test src/session/__tests__/goal-gate.test.ts src/session/__tests__/goal.test.ts`
  -> 19 pass, 0 fail (9 new + 10 existing).
- Before the fix (judge-failure test as `test.failing`): same file, 9 pass, 0 fail (the failing
  test is expected to fail and does).
- After the fix (same test flipped to `test`): 9 pass, 0 fail -- the judge-failure test now
  passes for real, not because it is marked expected-to-fail.
- `cd packages/core && NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` -> clean, both
  before and after the fix.

Root cause of the biggest time sink while writing this test (recorded for whoever picks up a
similar test next): `Layer.provide(dependency)` satisfies a layer's requirement on `dependency`
but **hides** `dependency`'s own services from the result (an "identity" merge in
`effect/Layer.js`); `Layer.provideMerge` keeps both. `Goal.runGate` is a standalone `Effect.fn`
that requires `Session.Service` and `Bus.Service` directly from the ambient context at *call*
time (not just at `Goal.layer`'s *build* time, where they are already closed over). Building the
test layer as `Layer.mergeAll(Goal.layer, fakeSessionLayer).pipe(Layer.provide(providerLayer),
Layer.provide(authLayer), Layer.provide(configLayer), Layer.provide(Bus.layer))` silently hid
`Bus.Service` from `runGate`'s own `yield* Bus.Service`, producing a "Service not found:
@opencode/Bus" failure on every call that reached `runGate`'s body -- fixed by using
`Layer.provideMerge(Bus.layer)` for that one dependency.

## Items not started

3. Harness gate, eval and aggregate script tests (mirroring `research-gate.test.ts`).
4. Try-best: find why its processor tests skip even with `HORDECODE_ENABLE_TRY_BEST_HANDOFF` set;
   make them run.
5. Cost display characterization tests for `packages/tui/src/util/cache-state.ts`.
6. A test pinning the `max` agent's current behavior without `experimental.maxMode`.

No code was written or tests run for these; they are exactly as described in the brief and the
X-ray report, nothing more is known about them than what those documents already say.

## Verification commands (for re-running)

```bash
cd packages/opencode && bun test test/session/advisor-loop-turn.test.ts
cd packages/core && bun test src/session/__tests__/goal-gate.test.ts src/session/__tests__/goal.test.ts
cd packages/opencode && NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck
cd packages/core && NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck
```
