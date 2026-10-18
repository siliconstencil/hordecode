# Changelog

All notable changes to this project will be documented in this file.

## [0.1.2] - Unreleased

### Changed

- The core, CLI, server, TUI and support packages follow opencode 1.19.0 (from 1.18.34 via
  1.18.35): Copilot reasoning handling, C++ module file highlighting, the OpenAI ultrafast
  service tier, the pty connect order, @ai-sdk/xai 3.0.139 and gitlab-ai-provider 6.19.0.
  Hordecode keeps its own update flow.
- Session sharing uses the share server you configure with `enterprise.url`; the share
  command appears in the TUI once one is set.
- Update checks never install anything: a newer version shows the update notice and installs
  only when you confirm it or run `horde upgrade` (previously a newer patch release installed
  itself in the background).
- Every `HORDECODE_*` environment switch that has an `OPENCODE_*` twin is honored, with the
  `HORDECODE_*` value first; `HORDECODE_DISABLE_AUTOUPDATE` and `HORDECODE_DISABLE_MODELS_FETCH`
  had no effect before.
- The install script verifies the downloaded archive against the release's `SHA256SUMS`
  before extracting it, and takes the archive, checksum and version from one release.
- The memory embedding runtime loads when semantic search first starts instead of at
  startup.
- npm installs hard-link the embedding runtime next to the binary instead of copying it,
  about 70 MiB less disk use on linux-x64.
- The legacy model catalog loader no longer fetches models.dev at startup; the catalog comes
  from one source and is cached in one file.
- `horde github run` uses the token broker set in `OIDC_BASE_URL`, or `GITHUB_TOKEN` with
  `use_github_token: true`; `horde github install` explains that setup and changes no files.

### Fixed

- Subagent notifications and messages reach the right supervisor: tools know the calling
  supervisor's id, so a peer's or nested subagent's completion notice, a workflow's terminal
  notice and a subagent's `send` without a target go to the caller instead of being dropped
  or landing in the subagent's own session; tasks a subagent creates are owned by that
  subagent.
- The stuck-subagent notice goes to the parent session instead of the stuck subagent.

## [0.1.1] - 2026-10-13

First version on npm (`npm install -g hordecode`). 0.1.0 was published
incompletely on 2026-09-18 (one platform package of twelve), withdrawn the
same day, and its version number is retired by the registry.

### Security

- Scheduled shell commands need approval. A task read from
  `.hordecode/scheduled_tasks.json` runs its `shell` command only after the
  same command was scheduled through the `cron` tool and approved through the
  `bash` permission in the running process; a task file committed to a
  repository can no longer run commands on its own. Unapproved commands are
  reported in the session and not executed.
- Memory writes validate `scope`, `scope_id`, `type` and the session thread id
  as single path segments and check that the target stays inside the memory
  root, so crafted values cannot write outside it.
- Workflow workspaces resolve symlinks before the containment check, so a
  symlink inside a workspace cannot point a workflow outside it.

### Added

- npm distribution: meta package `hordecode` with one optional dependency per
  platform (linux, darwin, windows; x64 and arm64; glibc and musl; baseline
  variants for CPUs without AVX2).
- `horde upgrade` for npm, pnpm and bun installs: resolves the current
  version from the configured npm registry and reinstalls `hordecode@<version>`.

### Changed

- New project files are written under `.hordecode/` and a new config defaults
  to `hordecode.json`; `hordecode.json` and `.hordecode/` are discovered by
  both config loaders.
- The core, CLI, server, TUI and support packages follow opencode 1.18.34
  (from 1.17.18 via 1.18.15), including upstream's provider, compaction,
  retry and TUI changes. The web, desktop and UI packages stay at 1.17.18
  until their own port.
- Internal identifiers that had been renamed (Effect service keys, keymap
  symbols, command ids) use upstream's names again, so opencode plugins that
  reference them keep working; user-visible text stays Hordecode.
- The TUI brand line reads HordeCode with the accent bullet.
- Release lookups use the GitHub API endpoint (`api.github.com`) instead of
  the HTML release page, in both the CLI and the install script.
- The publish script refuses to start unless `dist/` holds all twelve platform
  packages at the release version.
- Chocolatey, Scoop and Homebrew remain unsupported; the messages no longer
  name a version.

### Fixed

- Scheduled prompts are delivered again: a cron fire ran outside the session's
  instance, so the follow-up session write used the working directory as the
  project id and failed with a database error.
- Each checkpoint write creates one hidden writer session again instead of an
  empty, visible session with the writer nested under it; the `session` tool's
  `list` and `dashboard` no longer show checkpoint writer sessions.
- A supervisor run that finishes without error is labelled `success` when the
  agent was never asked for a status header (for example `explore`), instead
  of `unknown`; `unknown` now only means an agent that was asked for a status
  header did not give one.
- `session` cancel no longer deletes a child's directory: it removes a
  worktree only when the directory is a git worktree under Hordecode's own
  worktree root; a child running in a plain subdirectory of a repository
  was removed recursively before.
- `supervisor wait` and group joins return the finished subagent's result
  text again; they looked for it under an agent id that is never stored.
- Interrupting a session cancels only its running or pending subagents; a
  subagent that already finished keeps its outcome, and a cancel never
  turns a delivered success into "cancelled". A turn that completes after a
  cancel keeps the cancelled outcome, and no follow-up turns run after it.
- A subagent spawned for a task (`task_id`) can write that task's progress
  journal and close the task: the task id now reaches the tool context, the
  journal is written under the session that owns the task, and the task
  tool finds the task in the parent session. Previously the journal write
  was refused, the subagent spent extra turns on it and reported "blocked".
- A supervisor's tool list (for example the checkpoint writer's) is
  enforced; a call to a tool outside the list is rejected.
- `supervisor run`/`spawn` with `supervisor_id` resume a finished subagent
  in its own session with its previous messages, as opencode's task resume
  does. An unknown id, a subagent that is still running, or a persistent
  peer return an explicit error instead of silently starting a fresh
  subagent.
- The `memory_session` tool description points to `memory_recall` for
  searching episodes (`scope=episodic`); the `memory` tool does not take that
  scope.
- Durations of a day or more show the right day and hour counts.
- A saved `opencode` theme loads again instead of silently falling back.
- Copying text in a TUI dialog no longer closes the dialog and drops the
  selection.
- The free-tier check and the home tips compare against the real `opencode`
  provider id.
- The TUI editor integration reads `HORDECODE_EDITOR_SSE_PORT` with
  `OPENCODE_EDITOR_SSE_PORT` as a fallback; the crash screen links to this
  project's issue tracker.
- Opening a session no longer writes a debug log to the temp directory.
- Databases created by older builds migrate without a drizzle journal error.
- The opencode free tier is not offered any more: opencode's server serves
  it only to the opencode client, so the free (cost 0) Zen models are hidden
  from the catalog even with a key, as MiMo Code does. Paid opencode models
  stay available with a key or login; opencode-go is unchanged. Without
  credentials every opencode model stays disabled, the TUI opens the provider
  dialog, and `horde run` reports "No provider configured".
- Session title generation runs in a forked fiber instead of blocking the
  first turn for up to 10 s.
- The chronological session prefix is forked by message position, not id order.
- Truncation files expire by modification time instead of the id timestamp.
- Undefined environment entries are dropped before the TUI worker spawns.
- MCP JSON-RPC error responses are treated as responses in the SDK patch.
- The CLI loads readline with a dynamic import; the background dependency
  install is joined before the embedding check exits.
- postinstall writes the real binary over the `.exe` placeholders on every
  platform.
- `edit` and `notebook_edit` accept a file as read once the `read` tool has
  returned it; the read-before-edit gate looked for the MiMo input key
  (`file_path`) while the read tool records `filePath`, so every edit of an
  existing file was rejected.
- `change_directory` and `view_image` no longer fail with "No context found
  for instance"; the session working directory falls back to the tool's own
  instance directory instead of the async-local Instance context.
- A directory set with `change_directory` is honoured by `read`, `write`,
  `edit`, `glob`, `grep`, `apply_patch`, `notebook_edit` and the shell tool
  when they resolve relative paths, as the tool description promises.
- The `codesearch` tool (an Exa-backed tool inherited from MiMo Code that
  Exa's server no longer serves by default) is not registered any more; add
  your own MCP server for code search.
- The built-in configuration skill is `customize-hordecode` (slash
  `/customize-hordecode`).
- `memory_gc` reports the retention sweep as `removedRetention`, so
  `totalRemoved` equals the sum of the reported counts.
- The provider connect dialog's API-key prompt for OpenCode Zen and OpenCode
  Go shows upstream's text again instead of a rebranded copy that pointed at
  products that do not exist; both providers stay available with an API key.
- The TUI "Open docs" command opens hordecode.com/docs instead of the
  opencode documentation.
- New and migrated config files get `"$schema": "https://hordecode.com/config.json"`,
  the schema that knows the fork's keys, instead of opencode's schema URL.
- The sidebar Subagents panel drops finished rows (completed, failed,
  cancelled) one minute after their last status change, so it shows live
  work; the subagent dialog (`ctrl+x down`) still lists them.
- Sidebar rows no longer wrap: subagent and task rows are cut to one line,
  the Telemetry tools line drops the "ok" count when errors are shown, the
  prompt footer hints never break mid-phrase, instruction files are shown
  relative to the session directory, and the session's own "main" registration
  no longer appears as a subagent row. The timing panel is titled Activity.
- The sidebar Activity panel has three tabs: Overview (uptime, turns, model
  time, tool time, spent, live operation), Tools (per-tool calls, average and
  longest duration, errors) and Tokens (in/out, reasoning and cache reads per
  agent); `ctrl+x a` cycles the tabs from the keyboard.
- `session join` no longer reports children that are still working as
  "unknown (no registered supervisor)" when the join times out; they are
  listed as still running with their status and turn count, and "unknown"
  is reserved for ids with no registry row.
- The checkpoint writer starts again: the runtime session layer now provides
  the request-prefix capture the writer needs (it was only wired in the
  unmounted core layer, so every threshold logged "prefixCaptureRef not set,
  skipping" and no checkpoint was ever written).

### Platforms

- All twelve targets are built. darwin-x64 ships without the on-device
  embedding index (onnxruntime-node 1.24.3 has no darwin/x64 binding);
  linux-x64 remains the verified target.

### Known limitations

- Subagents are spawned by the `supervisor` tool, which has no nesting limit
  (MiMo Code 0.1.12 later added a no-nested-delegation guard; Hordecode will
  decide on a limit in a later release). The upstream `subagent_depth` setting
  applies to upstream's task tool and is accepted but has no effect here.
- `horde web` serves the upstream web UI, which still carries opencode
  branding.

## [0.1.0] - 2026-09-13

First Hordecode release. Hordecode is a friendly fork of
[opencode](https://github.com/anomalyco/opencode) at `opencode@1.17.18`
(pinned as `hordecodeBase` in `package.json`), with the harness, supervisor,
inbox, and memory feature set ported on top of the upstream backend.

### Added

- Primary command `horde` with `hordecode` as an alias; no `opencode` entry
  is installed, so an install never shadows upstream opencode on `PATH`.
- Self-update (`horde upgrade`) against Hordecode GitHub Releases.
- Local memory with an optional on-device embedding index (`memory.embedding`,
  off by default; linux-x64 only in this release).

### Compatibility

- OpenCode plugins, the `opencode` model, `OPENCODE_*` environment variables,
  and the legacy `.opencode/` config tree keep working unmodified; every
  `HORDECODE_*` name is read first, then its `OPENCODE_*` twin.

### Platforms

- linux-x64 is the verified target. darwin-arm64, windows-x64, windows-arm64
  and linux-arm64 builds are provided without the embedding index and are
  not yet verified. darwin-x64 is not built in this release.

### Notes

- This is a pre-release; breaking changes may occur before 1.0 without a
  migration path.
- Upstream history is preserved; see `LICENSE` for attribution.
