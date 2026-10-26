# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3] - 2026-10-25

### Added

- Credential files are protected: the file tools and shell commands cannot read or write `auth.json` or
  `mcp-auth.json` in the data directory. The rule is applied after user, session and agent rules, so an allow
  rule or an "always" approval does not relax it. It follows symlinks and hard links and recognizes quoted
  words, `~`, environment variables and globs in shell commands.
- An optional permission audit log: set `HORDECODE_PERMISSION_AUDIT=1` and every permission decision and
  reply is written as one JSON line to `<data>/log/permission.jsonl`, with credentials in command patterns
  redacted. The file rotates at 5 MiB (`HORDECODE_PERMISSION_AUDIT_MAX_BYTES`) and keeps three older files.
- Plugins can observe permission decisions: the `permission.ask` hook runs after each decision with the final
  status (`allow` or `deny`). It reports only; the decision stays with the permission system.
- Optional command sandbox for the shell tool on Linux. Set `HORDECODE_SANDBOX=auto` to use bubblewrap when it
  is installed, or `required` to refuse to run commands without it. Commands then see the project directory
  read-write and the rest of the system read-only, with no network unless `HORDECODE_SANDBOX_NETWORK=host`.
  The default is off, which behaves exactly as before.
- A Cache line in the sidebar for Anthropic models: `Cache   warm 03:41` shows the time left of the prompt cache
  entry, and `Cache   cold  next turn re-caches ~190K tokens (~$0.48)` tells you what the next request will write.
  A warning is logged when the cache is not read on two consecutive large turns.
- A `cachePromptTTL` model setting (`"5m"` or `"1h"`) for Anthropic and OpenRouter models, and the 5 minute and
  1 hour split of cache writes is stored with each response when Anthropic reports it.
- On-device embeddings for hybrid memory search (`memory.embedding: true`) work on Linux, Windows and macOS on
  Apple silicon; musl Linux and macOS on Intel keep keyword search.
- The `default_agent` setting is honored when the terminal UI starts.
- Auto-approve is remembered per project and restored with a short notice when you reopen the project.
- The desktop app has a new Hordecode icon (a letter H) for the release, beta and dev channels on macOS,
  Windows and Linux, and the Windows executable carries the same icon with the product name, company and version
  in its file properties.
- Database maintenance at startup: `PRAGMA optimize` runs when the database opens, and a large write-ahead log
  is truncated. `HORDECODE_DB_MAINTENANCE=0` turns it off; `HORDECODE_DB_VACUUM=1` adds a bounded `VACUUM`.
- A `session.compaction.failed` event reports a compaction that could not fit the context and a loop that
  compacted repeatedly without progress.
- The bundled `drive-hordecode` skill ships its `scripts/wait-for-text.sh` helper and shows how to use it
  (bash and tmux required).
- [Docs] Pages for the supervisor, task, workflow, cron, skill and memory tools.

### Changed

- The core, CLI, server, TUI and support packages follow opencode 1.19.4 (from 1.19.3): the Bun 1.4.4
  toolchain, `@ff-labs/fff-bun` 0.10.5, and cross builds that install the native packages for both libc
  variants. Hordecode keeps its own update flow.
- The web app, the desktop app and the shared UI packages follow opencode 1.19.4 (from 1.17.18), including
  the v2 session views, plural-aware UI text and the new markdown renderer.
- Desktop menus, recovery messages and WSL messages read "Hordecode" in every language.
- One hour prompt cache writes are priced at twice the model's input price, as Anthropic bills them; five
  minute writes keep the catalog cache write price.
- A permission request that nobody answers within five minutes now ends with the message "Permission request
  timed out after 300s, command not run." in the transcript and as the tool result; the session continues
  instead of stopping as if you had refused.
- The sidebar lists every modified file again, with long paths shortened from the left.
- A compaction that repeats without a finished step in between stops after two attempts instead of continuing
  until the step limit.
- The documentation site no longer shows the upstream v2 announcement bar.
- Agents are told to read files with Read, Glob and Grep and to change them with Edit and Write instead of shell
  commands such as `cat`, `sed` or heredocs.

### Fixed

- The terminal UI no longer stops with "bootstrap timed out" in terminals that answer its color queries at
  once, such as Konsole.
- A `bash` deny rule such as `"rm *": "deny"` blocks a delete command again instead of asking, and an
  `external_directory` deny rule blocks deletes outside the project too.
- A shell command whose directory is a symlink that leads out of the project now asks for the external
  directory permission, like any other path outside the project.
- Task operations on an unknown task id (`block`, `unblock`, `done`, `abandon`, `rename`) answer
  `Task <id> not found. Use task list to see valid task IDs, or task create to add one.`
- The `drive-hordecode` skill no longer points at a helper script that was missing from the bundle.
- Importing the project package on its own no longer fails with an initialization error.
- macOS builds keep a consistent code signature after the build path is removed from the binary.
- The desktop type check uses the same compiler as upstream, so it no longer reports errors that upstream's
  does not.

## [0.1.2] - 2026-10-20

### Added

- Auto-approve applies to the whole running process: the TUI toggle (**Enable auto-approve
  permissions**) and `horde --auto` now also cover requests raised by subagents, pending
  requests are released when the mode is switched on, and the server exposes the switch at
  `GET`/`POST /permission/skip-all`. Explicit `deny` rules still win. Requests that always
  ask, such as a deleting shell command, still prompt; when nobody answers within 60 seconds
  (`HORDECODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS`) the request is rejected with a message that
  tells the model to skip that step and continue.
- The harness skills ship their evidence gate: every harness run mints a run id, each phase
  writes its evidence under `.hordecode/harness/evidence/<run-id>/`, and the gate script
  checks that evidence before the next phase, with eval results under `docs/harness/eval/`.
  The merge skill runs the merge gate and the deliberate skill records its reasoning there.
- The research skills ship their evidence gate and scoring: each phase (scope, gather,
  verify, filter, synthesize, decide, eval) writes `<phase>.evidence` under
  `findings/<run-id>/` and runs the research gate; phase scores measure the structure of the
  deliverable and its evidence file, not vocabulary. Research subagents are dispatched through
  the supervisor tool with role templates (researcher, auditor, reviser); research decisions
  are recorded in project memory with `memory_add`; the research methodology standard is
  bundled and linked from the research skill.

### Changed

- The core, CLI, server, TUI and support packages follow opencode 1.19.3 (from 1.18.34 via
  1.18.35, 1.19.0, 1.19.1 and 1.19.2): Copilot reasoning handling, C++ module file
  highlighting, the OpenAI ultrafast service tier, the pty connect order, model variants built
  from configured reasoning options, @ai-sdk/xai 3.0.139 and gitlab-ai-provider 6.19.0.
  Hordecode keeps its own update flow.
- Session sharing is removed, as upstream discontinued it: `/share`, `/unshare` and
  `horde run --share` are gone, and `horde import` reads session JSON files.
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
- Model requests identify Hordecode: the default `User-Agent` is `hordecode/<version>`, and
  the attribution headers sent to OpenRouter, Vercel, LLM Gateway, ZenMux, Kilo and Cerebras
  name Hordecode (`https://hordecode.com/`). Providers hosted by opencode and the provider
  integrations carried unchanged from upstream (GitHub Copilot, ChatGPT sign-in, xAI, Azure,
  DigitalOcean, Snowflake, NVIDIA billing) keep the opencode identity.
- Supervisors delegate through nested subagents three levels deep by default (main agent,
  coordinating supervisor, workers, helpers); `subagent_depth` sets it from 0 to 8. Only
  subagent links count toward the depth; peers do not.
- The supervisor tool runs up to 8 subagents at once in a session and the sessions under it;
  `supervisor.max_subagents` raises this up to 16. Workflow agents keep their own limit
  (`workflow.maxConcurrentAgents`).
- A subagent's step limit is applied: the agent's `steps`, else 100. The loop ends after the
  last allowed step even if the model asks for more tools.
- The supervisor tool's `context` option accepts `none` and `state`. `full` is rejected: it
  never worked, so it is no longer offered.
- Recurring cron jobs are removed once they come due more than 7 days after creation, unless
  the job is created with `permanent: true`; the last run still fires. Loop jobs end the same
  way, 7 days after they were first armed. The cron tool description now says so.

### Fixed

- `supervisor run` honors its `timeout_ms` and a cancelled parent: the call returns when the
  timeout or the cancel comes, instead of waiting for the subagent to finish.
- Cancelling a subagent resolves its result as cancelled, also when the cancel arrives before
  the subagent's first step has started.
- `supervisor wait` returns the subagent's final result, after its preStop and completion
  checks, not the output of its first turn.
- A subagent's child session is titled with its task description (or its agent name when the
  description is empty) and the agent marker; long tasks are no longer cut mid-word.
- `memory_session` respects `memory.disable_write`, like the other memory writes.
- The `memory_recall` description, the session `list` description and the supervisor tool's
  operation list match what the tools do (the list now includes `models`).
- Subagent notifications and messages reach the right supervisor: tools know the calling
  supervisor's id, so a peer's or nested subagent's completion notice, a workflow's terminal
  notice and a subagent's `send` without a target go to the caller instead of being dropped
  or landing in the subagent's own session; tasks a subagent creates are owned by that
  subagent.
- The stuck-subagent notice goes to the parent session instead of the stuck subagent.
- An interrupt cancels running subagents at every nesting level, not only direct children.
- A nested subagent can bind a task owned by an ancestor session with `task_id`.
- The session tool reports a subagent child's status, lists it as a subagent in the
  dashboard, and cancels its row.
- Supervisor ids are unique per project (`general-1`, `general-2`, ...), so two root
  sessions no longer hand out the same id.
- A child session created with an explicit directory records that directory.

- Permission prompts raised by a subagent reach the parent TUI instead of being denied as if
  the subagent ran unattended; an explicit approval granted to a background subagent is
  honoured, and a request denied because nobody can answer says so in its message.
- Research mode runs its phases in the order the research skill describes: review, verify,
  report, merge, then eval.
- Every research skill carries a description, so the research skills are listed in the skill
  tool and in the mode's skill list.
- The harness and research skill bundles are complete: skill paths, the validation phase, the
  debug example and the research eval skill match their sources, and the harness preferences
  file is described by the data directory instead of a fixed home path.

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
