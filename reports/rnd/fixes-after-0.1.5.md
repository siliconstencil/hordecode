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
| off (default) | any | no tool runs; assistant message gets an `UnknownError` naming the cause and the flag; `Session.Event.Error` published; turn ends |
| on | yes, all tools known and allowed for the supervisor | calls recorded on the last assistant message and run via `handle.replay` over `SessionTools.resolve` tools (same permission asks, denials, plugin hooks as a structured call); loop continues with the results |
| on | unknown tool, supervisor allowlist hides it, or any failure | nothing runs (all or nothing); notice as above |

Notes:
- A tool denied by rule (DeniedError) is a tool error returned to the model, same as a structured call under a deny rule (processor.ts `failToolCall` blocks the turn only for RejectedError). The test asserts this, not turn end.
- The DSML text part stays on the message. Tool call ids are `dsml_<assistantID>_<n>`.
- `HORDECODE_DSML_NOTICE=0` restores the silent end.
- Provenance: FORK_ONLY. Upstream v1.19.5 and MiMo v0.1.11 have no DSML handling (reference checkouts `../repos/` were not available in this container; not re-verified). The core copy (`core/src/session/prompt.ts:1969`, unmounted) publishes `TextToolCallError` and stops; the new code keeps that end and adds the notice.
- Tests (`opencode/test/session/dsml-retry-turn.test.ts`, fake LLM): salvage parse+execute, permission-denied path, notice path, notice switched off. Three of the four fail without the source change; the switched-off test passes either way (it pins the old behaviour).
- Resolved in round 3: per-session cap `DSML_SALVAGE_LIMIT = 3` (171af18).

### 3. Advisor re-arm

- `NO_PROGRESS_REARM = false` exported from `trigger.ts`; `evaluate(..., options.rearmNoProgress)` overrides it (used by tests; the hook does not pass it, so production follows the constant).
- Rule when on and repeat suppression would block: fire again if `callsSinceWrite - base >= no_progress`, where `base` is the count recorded in the last fire, or 0 when the count is now below it (a write reset the streak).
- Unchanged: cooldown, thresholds, severity, delivery, suppression of every other trigger name.
- OPEN DECISION: the hook wires the constant only. A config key (`experimental.advisor.rearm`) would need a schema and SDK change.

### 4. fork-release verify

Cause: the phase ran `HOME=<isolated> bash install.sh` with the maintainer PATH. The installer (`install` line 250) skips installing when `command -v horde` already reports the requested version, so on the maintainer machine (horde 0.1.5 present) it installed nothing and the following `--version` check read the isolated path, which did not exist.

Change (script/fork-release.sh):
- `isolated <home> cmd...` = `env -i HOME=<home> PATH=/usr/bin:/bin TERM=dumb LANG=C.UTF-8 cmd...`.
- The phase first fails if the isolated PATH already resolves a `horde` (the check would prove nothing).
- Installer and the installed-binary version check both run through `isolated`; the installer is pinned with `--version "$VER"` (previously it installed "latest", which is not necessarily the version being verified).
- The `curl` download of `install.sh` and the npm step are unchanged (maintainer environment: proxy, npm config).

Dry explanation (what a run does now): download `install.sh` -> `env -i HOME=$base/home PATH=/usr/bin:/bin bash install.sh --version 0.1.x` -> installer sees no horde, downloads the GitHub asset, verifies the checksum, writes `$base/home/.hordecode/bin/horde` -> `env -i ... horde --version` must equal `$VER`. Not executed against the network here (no release to verify).

Verification: `bash -n script/fork-release.sh` ok; `bash script/fork-release.test.sh` 10/10 ok, 0 against the old script (the helper is missing). `shellcheck` is not installed in this container, so it was not run.
- OPEN DECISION: the minimal PATH `/usr/bin:/bin` assumes curl, tar, gzip and uname live there; on NixOS or Homebrew-only hosts add the directories explicitly.

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

## Verification (measured)

Base = `094f510aa6` (v0.1.5), checked out as a separate worktree with its own install; head = branch tip before this report commit, `55da04f`. Same container, NODE_OPTIONS=--max-old-space-size=8192.

| Package | typecheck base / head | tests base | tests head |
|---|---|---|---|
| cron | clean / clean | 46 pass, 0 fail | 51 pass, 0 fail |
| skill | clean / clean | 39 pass, 0 fail | 43 pass, 0 fail |
| core | clean / clean | 1467 pass, 4 skip, 2 fail | 1477 pass, 4 skip, 2 fail |
| opencode | clean / clean | 4482 pass, 25 skip, 3 fail | 4503 pass, 25 skip, 3 fail |

- The failing tests are the same set on base and head: core `util.flock` and `util.effect-flock` "unwritable lock roots" (container runs as root); opencode `HttpApi Server.listen` response logs, `config/tui` legacy source, `tool.write` OS denies write.
- New passing tests: cron +5, skill +4, core +10, opencode +21.
- The base worktree is `/home/user/hordecode-base` (registered with `git worktree`; remove with `git worktree remove /home/user/hordecode-base` when no longer needed).
