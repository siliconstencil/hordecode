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
- OPEN DECISION: should salvage also cover the case where a DSML block is present but the retry limit is 0? Today `dsmlToolCallStop` is evaluated the same way, so yes it applies; not separately tested.
- OPEN DECISION: salvage is per message and unbounded across turns; a model that always writes DSML would be salvaged every turn. A per-session cap is not implemented.

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

## Verification (measured, rnd/fixes-after-0.1.5 at 5b8a89e)

| Package | typecheck | tests |
|---|---|---|
| cron | clean | 48 pass, 0 fail |
| skill | clean | 42 pass, 0 fail |
| core | clean | 1470 pass, 2 fail |
| opencode | clean | 4496 pass, 3 fail |

- core 2 failures: `util.flock` and `util.effect-flock` "unwritable lock roots" (container runs as root; fail on the baseline).
- opencode 3 failures: `httpapi-listen` (response logs), `config/tui` (legacy source), `tool/write` (OS denies write). Identical on `prep/0.1.5`.
- opencode typecheck and the pre-push hook need `NODE_OPTIONS=--max-old-space-size=8192` here (default heap aborts).
