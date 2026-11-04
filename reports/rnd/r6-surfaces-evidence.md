# rnd/r6-surfaces-evidence (slice R6-3): surface evidence

Base 094f510aa6. Input: reports/xray/surfaces.md (branch rnd/xray-surfaces), re-checked claim by claim. Session ended early: items 1-4 done, 5-6 not started.

## Done

### 1. /rebuild: exact text the model receives
- Observation: `/rebuild` is registered with template `$ARGUMENTS` (opencode/src/command/index.ts:167-176); nothing else references `Command.Default.REBUILD`.
- Evidence: test/session/rebuild-command.test.ts (scripted LLM server, real Session/Prompt services, request bodies from `llm.inputs`; the in-repo server records every request, so the xray "mock logger overwrote its file" problem does not exist here).
  - `/rebuild` with no arguments: command succeeds, 1 model call, the request holds only the system prompt (roles: `["system"]`); the model gets no instruction.
  - With arguments `now please`: the user message is exactly `now please`.
  - No compaction part and no summary message is written (no checkpoint rebuild runs).
- Revert-the-feature (registration removed in a scratch edit): 0 pass / 3 fail; restored: 3 pass / 0 fail.
- Commit e20e177. Action for the owner: wire to `rebuildFromCheckpoint` or retire (OPEN DECISION, unchanged from the xray).

### 2. serve UnknownError
- Reproduced on a long-running `horde serve` (`--print-logs --log-level DEBUG`, project dir with no config at start, config written afterwards, scripted OpenAI-compatible server on 127.0.0.1): `POST /session` works, `POST /session/{id}/message` returns `UnknownError` ("Unexpected server error", ref err_91504a01).
- Root cause (from the DEBUG log stack): `SessionPrompt.getModel` (prompt.ts:1721) reads the models catalog; `ModelsDev.populate` (core/src/models-dev.ts:217-232) with no cache file, no bundled snapshot (`OPENCODE_MODELS_DEV`, release builds only) and an unreachable host ends in `Effect.orDie`, so the request dies. NOT related to serve being long-running or to the config appearing later (the config was picked up). `horde run` fails the same way (err_977c1b28).
- Confirmed by control: same server with `HORDECODE_DISABLE_MODELS_FETCH=1`: message and command requests both succeed (the mock LLM saw the request).
- Test: core/test/models-offline.test.ts: characterization (get() dies when fetch fails and nothing is cached) passes; control (fetch disabled returns `{}` with 0 requests) passes; `test.todo` for the desired behavior. Revert check: scratch edit making populate degrade to `{}` makes the characterization fail (1 pass / 1 fail / 1 todo); restored: 2 pass / 1 todo.
- Side observation (not investigated): with fetch disabled `horde run -m test/test-model` reports "Model not found" while the serve request with an explicit model works; and with the scratch degrade edit `horde run` did not finish within 90 s (cause not examined).
- OPEN DECISION: degrade to an empty catalog and log, or keep failing loudly. models-dev.ts is FORK_DELTA, so the change needs the owner and an upstream citation. Commit 15100e8.

### 3. `debug embedding-check` does not exit
- Not reproducible with a fast-failing registry (exits in 2-8 s). Reproduced with a registry host that accepts the connection and never answers: the command prints `{"available":false,"state":"disabled"}` and is still running at 100 s (timeout 124).
- Root cause: the handler ends with `Effect.ensuring(svc.waitForDependencies())` (debug/index.ts), which joins the detached `npm install` of `@opencode-ai/plugin` that Config starts for every config directory (config/config.ts:497-517). The join is intentional (comment: avoid leaving the install lock held), so the hang is a design trade-off. A refused connection (127.0.0.1:1) also did not finish within 60 s because npm retries with backoff.
- Test: opencode/test/cli/debug/embedding-check-exit.test.ts: control (registry answering 404 at once: exits, prints the result) passes; `test.failing` (exits within 30 s while the registry never answers) is red-by-design. Revert check (join removed, scratch): 1 pass / 1 fail (the `test.failing` test then passes unexpectedly); restored: 2 pass / 0 fail.
- OPEN DECISION: bound the wait (value is the owner's) or detach. debug/index.ts is FORK_DELTA. Commit in this branch (message "test(opencode): embedding-check outlives its output ...").

### 4. Bundled reference config.md (FORK_ONLY)
- Test first: skill/test/reference-config.test.ts: every `HORDECODE_*` name in the doc must be read by product code outside flag.ts (CORE_ONLY listed as derived, checked) and the schema URL must be the one the product writes. Before the fix: 2 fail (unread: DISABLE_CLAUDE_IMPORT, DISABLE_CODEX_SKILLS, DISABLE_HARNESS_SKILLS, DISABLE_OPENCODE_SKILLS, LOOP_KEEPALIVE_BUDGET, LOOP_KEEPALIVE_DELAY_S; URL wrong). After: skill suite 42 pass, 0 fail; typecheck 0 errors.
- Verified per name (consumers outside flag.ts): HOME 8, CONFIG_DIR 21, PURE 5, DISABLE_LOG_ROTATION (core/src/util/log.ts:77), TEXT_TOOL_CALL_RETRY_LIMIT (default 2, flag.ts:132), EXPERIMENTAL_CRON (default on), DISABLE_CRON (session.ts:545), TOKEN_EFFICIENCY_HEURISTIC (core/src/tool/bash.ts:528), DISABLE_BUILTIN_SKILLS (core/src/session/prompt.ts:618), DISABLE_EXTERNAL_SKILLS and DISABLE_CLAUDE_CODE_SKILLS (opencode/src/effect/runtime-flags.ts:40,63), DISABLE_PROJECT_CONFIG 12: live. CORE_ONLY: live only through derived flags (flag.ts:28-30,140-141). Dead: LOOP_KEEPALIVE_BUDGET and _DELAY_S (defined at flag.ts:203-207, no reader; keepalive strikes exist in cron/loop-state.ts but use neither), DISABLE_HARNESS/CODEX/OPENCODE_SKILLS (defined, no reader), DISABLE_CLAUDE_IMPORT (not defined anywhere).
- Doc changes: removed the four dead toggles and the keepalive sentence; removed "fall back to the Hordecode-auto model" (no code for it; grep finds only the doc); schema URL `https://hordecode.dev/hordecode/config.json` (3 places) to `https://hordecode.com/config.json`, which config.ts:645-686 writes. Commits: test, then 50178b9 (doc).
- Not checked: the rest of the doc (config key defaults such as tail_turns, task_archive_days, interval_days; the memory file layout).

## Not started
- 5. Seven dead schema keys, one characterization test per key (xray list: checkpoint.max_writer_failures, push_caps.design_decisions / focus_task / open_notes, try_best.bash_retries, experimental.batch_tool, layout; file:line in reports/xray/surfaces.md sec. 3.1, not re-verified).
- 6. Verified list of the 18 flags without consumer and the 13 fork-only TUI files without importer (xray lists them; flag names with consumer counts for 7 of them were re-measured above for the doc names only: HARNESS/CODEX/OPENCODE skills and both LOOP_KEEPALIVE flags have 0 readers).

## Other measured numbers
- opencode typecheck for the new test files: not run in this round (pre-push hook typechecked inbox, core, opencode, supervisor on each push with NODE_OPTIONS=--max-old-space-size=8192 and passed).
- skill: 42 pass, 0 fail. core models-offline: 2 pass, 1 todo. opencode rebuild-command: 3 pass. embedding-check-exit: 2 pass.
- Known failures in other opencode suites were not re-run.
