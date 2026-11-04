# rnd/fixes-after-0.1.5

Base: `v0.1.5` (094f510aa6). Branch pushed to origin only; `prep/0.1.5` and `main` untouched.

## Brief 3 (shipped earlier)

| Commit | Change |
|---|---|
| 7aaf813 | cron lock moved to `<state>/cron-locks/<sha256(realpath)>.lock` |
| addf493 | harness paths derived from `harness.docs` (`harnessPaths`, env contract for gate scripts) |
| a712a83 | advisor `no_progress` trigger (default 25, high 15, low 0) |

## Brief 4

| # | Result | Commit |
|---|---|---|
| 1 | SDK regenerated with `bun run build` in `packages/sdk/js`. The generated diff implied by the `no_progress` config change is empty: the hand edit was byte-identical to generator output, so there is nothing to commit. | none |
| 2 | DSML salvage (`HORDECODE_DSML_SALVAGE`, default off) and visible notice (`HORDECODE_DSML_NOTICE`, default on) | 1ebbfbd |
| 3 | `NO_PROGRESS_REARM` (constant, default off) | 6bf80f9 |
| 4 | `fork-release.sh verify` installer check under `env -i` | 364ad16 |
| - | CHANGELOG `[Unreleased]` | 5b8a89e |

### 1. SDK regeneration

- Generator: `packages/sdk/js/script/build.ts` (`bun dev generate` -> openapi -> `@hey-api/openapi-ts`, then patches and prettier).
- Result: the only diff against HEAD was `openTelemetryContent?: boolean` on `Config.experimental`. That field comes from 0.1.5 (`experimental.openTelemetryContent`, CHANGELOG 0.1.5) and was never regenerated into the SDK. It is not implied by the `no_progress` change, so it was reverted and not committed.
- OPEN DECISION: commit that one-line drift as its own `chore(sdk)` commit.

### 2. DSML salvage

Observation: DeepSeek V4.1 Flash via OpenCode Go wrote DSML as text three times in one session; after the retry cap (default 2) the turn ended silently.

Where: `packages/opencode/src/session/prompt.ts`, in the loop-exit block right after the retry branch (`dsmlToolCallStop`), plus the helper `salvageDsmlCalls` before `runLoop`.

Behaviour at cap exhaustion:

| Salvage flag | Calls parse complete | Outcome |
|---|---|---|
| off (default) | any | no tool runs; a display-only (ignored, synthetic) text part with the notice is added to the assistant message; the message is not marked as an error and no error event is published; turn ends |
| on | yes, all tools known and allowed for the supervisor | calls recorded on the last assistant message and run via `handle.replay` over `SessionTools.resolve` tools (same permission asks, denials, plugin hooks as a structured call); loop continues with the results |
| on | a name that is not a resolved tool (unknown, `Object.prototype` names), step budget spent, per-session cap reached, or any failure | nothing runs (all or nothing); notice as above. A tool hidden by the supervisor allowlist is rejected by `SessionTools.resolve` ("Tool not permitted") exactly as for a structured call |

Notes:
- A tool denied by rule (DeniedError) is a tool error returned to the model, same as a structured call under a deny rule (processor.ts `failToolCall` blocks the turn only for RejectedError). The test asserts this, not turn end.
- The DSML text part stays on the message. Tool call ids are `dsml_<assistantID>_<n>`.
- `HORDECODE_DSML_NOTICE=0` removes the note.
- Provenance: FORK_ONLY. Upstream v1.19.5 and MiMo v0.1.11 have no DSML handling (reference checkouts `../repos/` were not available in this container; not re-verified). The core copy (`core/src/session/prompt.ts:1969`, unmounted) publishes `TextToolCallError` and stops; the new code keeps that end and adds the notice.
- Tests (`opencode/test/session/dsml-retry-turn.test.ts`, fake LLM): salvage parse+execute, permission-denied path, notice path, notice switched off. Three of the four fail without the source change; the switched-off test passes either way (it pins the old behaviour).
- Resolved in round 3: per-session cap `DSML_SALVAGE_LIMIT = 3` (171af18).

### 3. Advisor re-arm

- `NO_PROGRESS_REARM = false` exported from `trigger.ts`; `evaluate(..., options.rearmNoProgress)` overrides it (used by tests; the hook does not pass it, so production follows the constant).
- Rule when on and repeat suppression would block: fire again if `callsSinceWrite - base >= no_progress`, where `base` is the count recorded in the last fire, or 0 when the count is now below it (a write reset the streak).
- Unchanged: cooldown, thresholds, severity, delivery, suppression of every other trigger name.
- Resolved in round 4: `experimental.advisor.rearm` (74b0ed6).

### 4. fork-release verify

Cause: the phase ran `HOME=<isolated> bash install.sh` with the maintainer PATH. The installer (`install` line 250) skips installing when `command -v horde` already reports the requested version, so on the maintainer machine (horde 0.1.5 present) it installed nothing and the following `--version` check read the isolated path, which did not exist.

Change (script/fork-release.sh):
- `isolated <home> cmd...` = `env -i HOME=<home> PATH=/usr/bin:/bin TERM=dumb LANG=C.UTF-8 cmd...`.
- The phase first fails if the isolated PATH already resolves a `horde` (the check would prove nothing).
- Installer and the installed-binary version check both run through `isolated`; the installer is pinned with `--version "$VER"` (previously it installed "latest", which is not necessarily the version being verified).
- The `curl` download of `install.sh` and the npm step are unchanged (maintainer environment: proxy, npm config).

Dry explanation (what a run does now): download `install.sh` -> `env -i HOME=$base/home PATH=/usr/bin:/bin bash install.sh --version 0.1.x` -> installer sees no horde, downloads the GitHub asset, verifies the checksum, writes `$base/home/.hordecode/bin/horde` -> `env -i ... horde --version` must equal `$VER`. Not executed against the network here (no release to verify).

Verification: `bash -n script/fork-release.sh` ok; `bash script/fork-release.test.sh` 10/10 ok, 0 against the old script (the helper is missing). `shellcheck` is not installed in this container, so it was not run.
- Round 4: `HORDECODE_VERIFY_PATH` overrides the minimal PATH; the proxy/CA drop is documented in the script comment (8153157).

## Round 3 (review `origin/rnd/reviews-0.1.6:reports/rnd/review-rnd-fixes-after-0.1.5.md`)

| Finding | Commit | Result |
|---|---|---|
| F6 SDK drift | 44fabd6 | `chore(sdk)`: generator output adds `experimental.openTelemetryContent` only. |
| F1, F2, F3 harness | 334d008 | See below. |
| F4 advisor | b752f10 | `no_progress` counts only consecutive read-only calls. |
| DSML cap | 171af18 | `DSML_SALVAGE_LIMIT = 3` per session, then the notice. |
| F5 cron overlap | 45a07bd | Live legacy `.hordecode/.cron-lock` is honoured. |
| F6 citations | 44d9a41 | Upstream and MiMo status cited at the `no_progress` config key. |
| docs | b752f10, 55da04f | `docs/CONFIGURATION.md` (trigger + preset table), CHANGELOG. |

### Harness (F1, F2, F3)

- `harnessPaths(worktree, cfg)` now returns absolute paths. Default docs dir: evidence stays `<worktree>/.hordecode/harness/evidence`. Custom `harness.docs`: evidence is `<state>/harness-evidence/<sha256(worktree)[:32]>`, never in the docs tree. "Custom" compares resolved paths, so `./docs/harness` and `docs/harness/` are the default (F2 edge case); `docs_absolute` with the default string keeps the default evidence location.
- The harness agent's injection (`core/src/session/harness-injection.ts`) states absolute paths and marks the session in `HarnessEnv` (`core/src/session/harness-env.ts`). The shell tool (`opencode/src/tool/shell.ts` `shellEnv`) exports `HORDECODE_HARNESS_DOCS` and `HORDECODE_HARNESS_EVIDENCE` for that session; `Session.createNext` copies the mapping to every session created under it (`opencode/src/session/session.ts`). Supervisors that run inside the same session share the session id. Sessions of other agents get a paths-only block when they are marked (subagents), so no model substitution and no env prefix are needed. The gate script reads the env; evidence is no longer derived from `HORDECODE_HARNESS_DOCS`.
- Research: the injection is gated on `skillPipeline`. The research agent receives exactly the 0.1.5 text (test compares against the base formula); build and unmarked sessions are untouched.
- Provenance: MiMo Code v0.1.11 `packages/opencode/src/session/prompt.ts:936-944` injects the docs text only when the user message agent is `compose`, resolves only specs/plans/reports and uses no env or evidence path (checkout `../repos/mimocode-v0.1.11`, tag v0.1.11). `config/compose.ts:18-23` is the relative-passthrough `resolveDocsDir` that the fork keeps for the research text. The env export and evidence relocation are fork additions.
- Tests: `core/test/config/harness-paths.test.ts` (5), `core/test/session/harness-injection.test.ts` (5: paths, session mark, subagent block, research byte-identical, build untouched), `opencode/test/tool/shell.test.ts` (env reaches a child session's command, not another session), `opencode/test/session/session.test.ts` (child inherits), `skill/test/harness-gate-paths.test.ts`. Each failed before the change; the shell and session tests were re-run with their source line disabled (0 pass / 1 fail each).
- Still model-dependent: skills tell the model to write files at `<harness-docs>/...`; the injected text gives the absolute value, but a write through the `write` tool is not intercepted. The gate scripts and everything run through the shell no longer depend on the model.
- OPEN DECISION: the minimal-injection block for marked sessions reaches any session created under a harness session, including non-harness subagents (by design, F1 scenario B).

### Advisor (F4)

- Fact renamed `readOnlyStreak`: trailing terminal read-only calls (`read grep glob list ls webfetch websearch codesearch lsp view_image skill`); any other tool call, including bash, task, supervisor, workflow, session, edits and unknown MCP tools, resets it, whatever its status. Default 25 kept (high 15, low off).
- Remaining F4 points not changed: repeat suppression by trigger name (re-arm constant stays OFF), default-on for existing advisor users (OPEN DECISION: ship 25 or default 0).

### Cron (F5)

- `tryAcquireSchedulerLock` reads the legacy lock first and declines when its owner is a live process other than this one (uses the existing PID-recycle check). It never writes or deletes the legacy file. One-sided: a previous-version process started after the new one cannot see the state-dir lock; closing that would mean writing the legacy file again. Dead, malformed and own-pid legacy locks are ignored. Stale legacy files stay (zero delete); the dead `.cron-lock` entries in the generated `.gitignore` are left as they are.

### Citations (F6)

- Upstream v1.19.5 (checkout `../repos/opencode-1.19.5`, tag v1.19.5) has no advisor and no `files_touched`; its experimental block is `packages/core/src/v1/config/config.ts:169-173`. MiMo v0.1.11 `packages/opencode/src/config/config.ts` has no advisor. The `no_progress` key is `FORK_DELTA` (`core/src/v1/config/config.ts`, comment at the key) and `FORK_ONLY` (`core/src/config/config.ts`); `packages/sdk/js/src/v2/gen/types.gen.ts:2227` is generator output.

## Round 4 (review `origin/rnd/reviews-0.1.6:reports/rnd/review2-rnd-fixes-after-0.1.5.md`)

| Finding | Commit | Result |
|---|---|---|
| F1 step budget | 0445eac | Salvage skipped when `step >= steps ?? agent.steps ?? 100` (the loop's own limit). Test: `agent.build.steps = 1`, three DSML `read` calls: before the fix 1 completed tool part, now 0 parts and the notice. |
| F2 notice behaviour | 969572f | Notice is an ignored synthetic text part; no `lastAssistant.error`, no `Session.Event.Error`. Comparison test runs one scenario twice (`HORDECODE_DSML_NOTICE=0` = the 0.1.5 end, and default) and requires identical normalized message history (minus the notice part), identical model request body of the next prompt, identical assistant errors and identical error events; it failed on the old implementation (notice count 0, error set). |
| F3 mutants D1, D2 (+D3) | 866b801 | New tests: block with an unknown tool runs nothing; `constructor` block runs nothing; two-call block runs both in order; allowlist through a real supervisor row. Redundant allowlist check removed. Re-run mutants: D1 (always true) 2 tests fail, D3 (`some`) 2 fail, `in` operator 1 fail, loop agentID dropped 1 fail. D6 (`bypassAgentCheck`) and D7 (Plugin service) are not asserted: no behaviour of the tools used differs (stricter flag; hook has no fixture here). |
| F4 | 866b801 | `Object.hasOwn` instead of `in`; salvage uses the same part the trigger matched (complete and trailing); `messages: []` is not an issue: tools receive messages through `SessionTools.resolve` (`input.messages`), and no tool reads `options.messages` (grep). |
| F5 re-arm | 74b0ed6 | `experimental.advisor.rearm` (schema in both core configs, SDK regenerated: the diff is the one field, no other drift). Hook tests: default off and `false` stay quiet, `true` fires again. |
| F6 release verify | 8153157 | Real `phase_verify` run against stub npm/gh/curl and a stub installer: pin (`--version 0.0.9`), env (maintainer secret and proxy absent, `PATH=/usr/bin:/bin`), guard (fails before the installer runs). Mutants: pin removed and guard disabled both exit 1. Proxy/CA drop documented in the script comment; `HORDECODE_VERIFY_PATH` added. |
| docs | e4819e8 | CHANGELOG. |

Findings of the audit not covered by a code change:
- Found while testing F3: the DSML retry re-entry user message carries no `agentID`, so after retries `lastUser.agentID` is empty and the loop loses the supervisor row (allowlist, ask routing) for the retried step. Salvage now reads the loop's own `agentID`. The retry itself is 0.1.5 behaviour and is unchanged on purpose (F2: with salvage off, nothing but the notice may change). OPEN DECISION: add `agentID` to the retry re-entry message.
- The existing text-call retry still loops past the step cap (pre-existing, not new; only the tool execution is gated now).
- OPEN DECISION (owner, F2): keep the notice on by default (now display-only).
- Not asserted: `tool.execute.before` plugin hooks and `bypassAgentCheck` on the salvage path (D6, D7); both are inherited from the shared `SessionTools.resolve` and are not specific to salvage.

## Verification (measured)

Base = `094f510aa6` (v0.1.5, separate worktree with its own install); head = `e4819e8` (the branch tip before this report commit). Same container, NODE_OPTIONS=--max-old-space-size=8192, base re-measured this round.

| Package | typecheck base / head | tests base | tests head |
|---|---|---|---|
| cron | clean / clean | 46 pass, 0 fail | 51 pass, 0 fail |
| skill | clean / clean | 39 pass, 0 fail | 43 pass, 0 fail |
| core | clean / clean | 1467 pass, 4 skip, 2 fail | 1477 pass, 4 skip, 2 fail |
| opencode | clean / clean | 4482 pass, 25 skip, 3 fail | 4511 pass, 25 skip, 3 fail |
| script | `bash -n` ok | - | `script/fork-release.test.sh` 17 checks ok (10 before round 4) |

- Failing tests are the same set on base and head: core `util.flock` and `util.effect-flock` "unwritable lock roots" (container runs as root); opencode `HttpApi Server.listen` response logs, `config/tui` legacy source, `tool.write` OS denies write.
- Round 3 to round 4 (head): opencode 4503 -> 4511 pass (+8: step budget, comparison, unknown tool, prototype name, two-call block, allowlist, two re-arm hook tests, minus none). Cron, skill and core unchanged by round 4 (51, 43, 1477).
- The base worktree is `/home/user/hordecode-base` (remove with `git worktree remove /home/user/hordecode-base`).
