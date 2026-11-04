# Report: rnd/r6-agents-tests (round 6, slice R6-1: agent communication tests)

Base: `origin/main` = `094f510aa6` (released 0.1.5). Input: `reports/xray/agents-comms.md` (branch `rnd/xray-agents`); every
claim used from it was re-checked below. All tests drive the real code path: real `SessionPrompt` loop, `Supervisor`,
`Inbox`, registry and SQLite, with the repo's scripted `TestLLMServer`. Each scenario has a revert-the-feature check
(a scratch edit of the product file, never committed; the file was restored and verified clean with `git diff`).

## Commits

| Commit | Content |
|---|---|
| 30846e1bd | tests: inbox drain through the real loop, background completion, wake behavior, doc contradiction (items 1, 2, 3) |
| c4940379d | tests: `notifyParentOnComplete` passed and never read (item 6) |
| 03ec160fe | tests: `session ask` slice, model, dump fallback, helper child; one red (item 4) |
| 7f2a9170e | fix: `session ask` forks the main conversation or the peer's own slice only (item 4, FORK_ONLY file, MiMo provenance) |
| e031c8f87 | tests: `session ask` and workflow spawns bypass `subagent_depth` and `supervisor.max_subagents`; green controls and red tests (item 5) |
| (head) | this report |

Test files (all under `packages/opencode/test/supervisor/`): `r6-agent-comms.test.ts` (4 tests), `r6-notify-parent.test.ts`
(2), `r6-session-ask.test.ts` (6), `r6-limits.test.ts` (6), helpers `r6-helpers.ts`, `r6-ask-helpers.ts`, and `r6-harness.ts`,
a copy of `supervisor-test-harness.ts` that also exposes `Inbox.Service` and mounts the workflow runtime.

## Why the gap existed (observation, common to items 1 to 3)

`test/supervisor/supervisor-harness.ts:30-32` switches the inbox wake off on purpose ("A wake drains the row it was woken for
... so wake is switched off"), and the other "e2e" tests mock the registry, inbox and session services (for example
`nested-task-binding.test.ts`). So no existing test could see the drain, the completion notification or the wake. The new
tests use the layer that has them mounted.

## 1. Inbox delivery through the real loop

- Observation: `inbox.drain` at the loop head (`packages/opencode/src/session/prompt.ts:1516`) could be disabled with 66 related
  tests green.
- Root cause: no test sent a message while a turn was running and checked the next turn.
- Action: `r6-agent-comms.test.ts` "a message sent to a busy receiver is drained into its next turn": the receiver's first
  model reply is held (`llm.hold`), `Inbox.send` is called mid-turn, the reply is released; the test asserts the next model
  request carries the message as the last (user) message, the session holds a synthetic user message with the
  `<inbox from="ses_r6_sender:worker-1" ...>` wrapper, and the inbox row is gone.
- Evidence: passes at head. Revert A (`inbox.drain` call replaced by a no-op): 3 of the 4 tests in the file fail (this one and
  the two background tests), 1 passes (the pinned doc-mismatch test). Restored: 4 pass.

## 2. Background completion reaches the parent

- Observation: disabling the completion notification (`packages/supervisor/src/spawn.ts:553`) left 171 tests green.
- Action: "the child's result arrives in the parent's conversation as a supervisor notification": the parent spawns a
  background child, the child answers `CHILD-RESULT-XYZ`, nobody prompts the parent again. Asserts the parent's session holds
  the `<supervisor-notification>` user message with the result text and description, a parent model request carries both,
  and the inbox row was consumed.
- Evidence: passes at head. Revert B (notification condition forced false): 2 fail, 2 pass. Revert A: same 3-of-4 failure as
  item 1. Restored: 4 pass. Measured flow: 4 model calls (parent spawn, child, parent ack, parent reply to the notification).

## 3. Wake contradiction settled

- Observation: `supervisor.txt` says a finished background child does not wake its parent; `packages/inbox/src/inbox.ts:151-153`
  wakes it.
- Action and evidence: "actual behavior: the parent runs another turn with no new user prompt". In the scripted scenario
  exactly one real user prompt exists in the parent session, yet the parent made 3 model calls and holds 3 or more
  assistant messages: the parent IS woken automatically. Revert C (wake disabled in `inbox.ts`): 2 fail, 2 pass. A second
  test, `test.failing`, pins the doc: it expects `supervisor.txt` not to contain "does NOT auto-wake" and fails today.
- OPEN DECISION 1: code wakes, doc says it does not. The conservative reading is that the code is the product; the doc
  text in `packages/opencode/src/tool/supervisor.txt` is stale. Nothing was changed.

## 4. `session ask`

Six tests in `r6-session-ask.test.ts` (the ask is driven by a model tool call in an asker session; the fork child's request
is answered by the scripted server):

| Question from the X-ray | Measured |
|---|---|
| main session answered from its history | yes, answer returned, fork request contains the history |
| peer child (turns stored under its own session id) | answered, not "no activity": `sessions.messages({sessionID})` without `agentID` returns every slice, and the `agent === "main"` filter matches nothing so the code falls back to all messages |
| persona-name filter | the filter (`m.info.agent === "main"`, `tool/session.ts:146` before the fix) never selected anything; effect: a worker slice stored in the same session leaked into the fork (RED) |
| which model | the project default (`test-model`), not the model the target ran on (`other-model`); MiMo 0.1.11 `tool/session.ts:100` does `selectedModel ?? defaultModel()` and the tool path has no selection |
| raw-dump fallback | with `prefixCaptureRef.current` unset the tool returns `Question: ...` plus the raw history (2000 characters per message) as its output and makes no model call |
| helper child | one child session `ask: ...` stays under the target; `classifySession` says renderable, which `packages/core/src/session/visibility.ts` states is by design |

- Defect and fix: the "worker slice leaks" test was red (5 pass, 1 fail). MiMo 0.1.11 `packages/opencode/src/tool/session.ts:77-84`
  selects the slice by `agentID` (main slice if it has a user message, else the peer's own-session slice); the fix in
  `tool/session.ts` (FORK_ONLY per `docs/upstream-map-files.tsv`) does that, with a provenance comment. After the fix: 6 pass.
  Regression run of the neighbors after the fix: `test/supervisor` plus `test/tool/session*.test.ts` 103 pass, 0 fail.
- OPEN DECISION 2: the fork uses the project default model; use the target's own model instead?
- OPEN DECISION 3: the no-prefix fallback returns a raw history dump as the "answer" (MiMo returns "(fork-query unavailable:
  prefix capture not initialized)"); keep the dump, or return the notice? Not changed; the dump test is a characterization.
- OPEN DECISION 4: keep the visible `ask: ...` helper child (documented as by design) or hide it from lists.
- Observed once in an exploratory run, not asserted: the helper session showed a single registry row (mode `main`, agent
  `main`, status `pending`) right after the ask; whether such a row can count toward limits is not established.

## 5. Depth and breadth limits (red tests, not fixed)

`r6-limits.test.ts`, 6 tests. Controls are green: with `subagent_depth: 0` the `supervisor` tool refuses a subagent
("Subagent depth limit reached (0)"), and with `supervisor.max_subagents: 1` and the slot held by a running child a second
`supervisor spawn` is refused ("already running in this session"). Revert of both checks (`tool/supervisor.ts`: depth
condition and slot condition forced off): 0 pass, 2 fail; restored: 2 pass.

Four tests state what the limit should do and are expected to fail today. They are wrapped by `red()` in `r6-helpers.ts`
(inverts the body, same intent as `test.failing`; the Effect test helper has no `failing` variant), so the suite stays
green while the defect exists and the test fails, asking for the wrapper to go, once someone fixes it. With
`R6_UNWRAP=1` the bodies run bare; measured result, all 4 fail for the intended reason:

| Red test | Bare failure |
|---|---|
| `subagent_depth: 0`, `session ask` | a fork request was made (expected 0, got 1) |
| `max_subagents: 1`, slot held, `session ask` | a fork request was made (expected 0, got 1) |
| `subagent_depth: 0`, workflow `agent()` | the workflow result contained the subagent's answer |
| `max_subagents: 1`, slot held, workflow `agent()` | the workflow result contained the subagent's answer |

Provenance: `tool/supervisor.ts:428-429` and `tool/subagent-limits.ts:26-28` document that workflow and checkpoint spawns do
not go through the limits; nothing documents the same for `session ask`.
- OPEN DECISION 5: should `session ask` count toward depth and breadth? (not documented as exempt)
- OPEN DECISION 6: should workflow `agent()` spawns count? (documented as exempt today; the fork's own comment says
  deeper nesting could not be cancelled or found, which is the case the depth cap protects)

## 6. `notifyParentOnComplete`

- Observation: passed at `packages/inbox/src/inbox.ts:152`, typed at `packages/inbox/src/inbox-ref.ts:7`, read nowhere.
- Action: `r6-notify-parent.test.ts`: a scan of every `packages/*/src` file shows the name only in those two files and never as
  a property read or destructuring; a spy on `sessionPromptRef.current.loop` shows the inbox wake passes
  `notifyParentOnComplete: true` with `agentID: "main"`, and the real `session/prompt.ts` does not contain the name.
- Evidence: 2 pass at head. Revert (flag removed from the wake call): 0 pass, 2 fail. Restored: 2 pass.
- OPEN DECISION 7: remove the dead parameter, or implement what it was meant to do.

## Verification (measured, `NODE_OPTIONS=--max-old-space-size=12000`)

| Command | Result |
|---|---|
| `cd packages/opencode && bun run typecheck` | clean (65 s) |
| `bun test --timeout 30000 test/supervisor/r6-*.test.ts` (4 files) | 18 pass, 0 fail |
| `cd packages/opencode && bun test --timeout 30000` (full) | 4500 pass, 25 skip, 1 todo, 3 fail (4529 tests, 419 files, 755 s) |
| same command on the base commit `094f510aa6` (round 5, same machine) | 4482 pass, 25 skip, 1 todo, 3 fail (4511 tests, 415 files) |
| `cd packages/supervisor && bun test` / `cd packages/inbox && bun test` | 100 pass / 10 pass, 0 fail |

Head minus base: +18 passing tests and +4 files, which are exactly this branch's tests. The 3 failures are identical on base and
head: `HttpApi Server.listen > default in-process handler does not emit Effect HTTP response logs`,
`continues loading tui config when legacy source cannot be stripped`, `tool.write > error handling > throws error when OS
denies write access`. They are not the three named in the round brief (Instruction.system x2, V2 configuration loading); in
this sandbox, which runs as root, the write-denial test cannot fail the way it expects, and the other two were not
investigated. None involves this slice.

## Not done / limits

- One observed oddity not investigated: after a `workflow` tool call the parent's next model request ends with an extra
  synthetic user message (roles `system,user,assistant,tool,user`); the tests avoid depending on the last role there.
- Latency and token cost of the mechanisms were not timed.
- Items 5 and 6 are decisions for the owner; only item 4's slice selection was fixed (FORK_ONLY file, MiMo provenance).
