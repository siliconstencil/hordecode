<p align="center">
  <a href="https://hordecode.com"><img src="assets/logo.svg" alt="Hordecode" width="96" height="96"></a>
</p>
<h1 align="center">Hordecode</h1>
<p align="center">The AI coding agent built for the terminal.</p>
<p align="center">
  <a href="https://hordecode.com">Website</a> |
  <a href="https://hordecode.com/docs/">Docs</a> |
  <a href="https://github.com/siliconstencil/hordecode">GitHub</a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/hordecode"><img alt="npm" src="https://img.shields.io/npm/v/hordecode?style=flat-square" /></a>
  <a href="https://github.com/siliconstencil/hordecode/actions/workflows/fork-typecheck.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/siliconstencil/hordecode/fork-typecheck.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

---

Hordecode is a terminal-native AI coding agent. It is a friendly fork of
[opencode](https://github.com/anomalyco/opencode) that tracks upstream, carries a
delta-port of [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code), and adds its own
layer: a supervisor for long-running work, a harness pipeline, an inbox, persistent
memory with an optional on-device embedding index, skills, workflows and cron.

Every opencode provider, plugin and config file keeps working. Hordecode is not
affiliated with or endorsed by either upstream project.

## Why Hordecode

- **Long-running work is built in.** A supervisor runs delegated work as tracked child
  sessions with waiters and task links, so multi-step work survives past one turn. Tasks,
  workflows, cron and an inbox are tools the agent calls, not plugins to assemble.
- **Memory that stays local.** Seven memory tools keep project knowledge across sessions.
  Keyword search (BM25) works out of the box; semantic search is opt-in and runs on-device.
- **Skill pipelines ship with the binary.** A harness set of 16 skills (plan, tdd, debug,
  review, verify, ...) and a separate research set of 16 skills.
- **Visible, not a black box.** Running agents, subagents and scheduled jobs show in the
  sidebar with status and elapsed time.
- **A maintained base.** The core, CLI, server and TUI track the opencode 1.x line, so
  providers, plugins, MCP servers and existing config keep working.

## Base and upstream tracking

| Part | Follows | Notes |
| --- | --- | --- |
| core, CLI, server, TUI, SDK and the small packages | opencode 1.18.34 | ported as a whole at each base bump |
| web, desktop and shared UI packages | opencode 1.17.18 | lag behind; `horde web` still shows upstream branding |
| supervisor, harness, memory, inbox, cron, workflow, skill, task and the other fork packages | Hordecode | fork-only; supervisor and harness are customized ports of the MiMo Code designs (parity 0.1.11) |

Hordecode 0.1.x stays on the opencode 1.x line; each base bump ports a newer 1.x release
whole. The file-level ownership map is in [docs/UPSTREAM-MAP.md](docs/UPSTREAM-MAP.md).

---

## Quick Start

```bash
# npm (all platforms)
npm install -g hordecode

# One-line install (macOS / Linux)
curl -fsSL https://raw.githubusercontent.com/siliconstencil/hordecode/main/install | bash

# Run
horde
```

`hordecode` is an alias of `horde`; both commands are installed. On first launch, add a
provider with `horde providers` (or `horde auth`), then start a session.

Upgrade an existing install with the method it was installed with:

```bash
horde upgrade            # latest
horde upgrade 0.1.1      # a specific version
```

> [!WARNING]
> 0.1.x is a pre-release. APIs, config and storage may change without a migration path.

<details>
<summary><strong>Install script details</strong></summary>

The script installs into `~/.hordecode/bin` and adds that directory to your shell
profile unless you pass `--no-modify-path`.

```bash
curl -fsSL https://raw.githubusercontent.com/siliconstencil/hordecode/main/install | bash -s -- --version 0.1.1
curl -fsSL https://raw.githubusercontent.com/siliconstencil/hordecode/main/install | bash -s -- --no-modify-path
./install --binary /path/to/hordecode     # install a locally built binary
```

Set `HORDECODE_RELEASE_BASE` to install from a mirror of the GitHub releases.

</details>

<details>
<summary><strong>Platforms</strong></summary>

| Target | npm package | Notes |
| --- | --- | --- |
| linux-x64 | `hordecode-linux-x64` | verified target; ships the on-device embedding index |
| linux-x64 (no AVX2) | `hordecode-linux-x64-baseline` | |
| linux-x64 musl | `hordecode-linux-x64-musl`, `-baseline-musl` | Alpine and other musl systems |
| linux-arm64 | `hordecode-linux-arm64`, `-musl` | |
| darwin-arm64 | `hordecode-darwin-arm64` | |
| darwin-x64 | `hordecode-darwin-x64`, `-baseline` | no embedding index (no onnxruntime binding) |
| windows-x64 | `hordecode-windows-x64`, `-baseline` | use npm; the install script needs bash |
| windows-arm64 | `hordecode-windows-arm64` | use npm |

The `hordecode` npm package selects the right platform package at install time. On
targets without the embedding index, memory search falls back to BM25.

</details>

## What Hordecode adds

Fork features surface as tools the agent can call, not as extra CLI commands:

- **supervisor**: runs delegated work as supervised child sessions with spawn
  references, task links and waiters, so multi-step work is tracked past one turn.
- **task** and **workflow**: units of work, and declared multi-step workflows.
- **memory-add / memory-recall / memory-update / memory-session / memory-status /
  memory-dump / memory-gc**: persistent project memory. With `memory.embedding`
  enabled (linux-x64) recall uses an on-device embedding index; otherwise BM25.
- **skill** and **skill-search**: discover and load skills from the user and project
  skill directories; the bundled research pipeline ships as a skill set.
- **cron**: scheduled runs.
- **session**: manage sessions and worktrees, including a fleet view of running agents.

Behind the tools, the **inbox** carries messages between agents and sessions, and the
**harness** pipeline drives supervised runs.

The upstream tool set (read, edit, bash, grep, glob, lsp, MCP, plan, question, ...)
and the built-in **build**, **plan** and **general** agents are unchanged. Switch
agents with `Tab`.

### Memory search: keyword by default, semantic opt-in

Memory recall is keyword search (BM25) out of the box and needs no download. Semantic
(vector) search is opt-in. Enable it in `hordecode.json`:

```json
{ "memory": { "embedding": true } }
```

On first use Hordecode downloads the embedding model once (about 133 MB) into its cache
directory; recall stays keyword-only until the model is ready, then becomes hybrid
(keyword + semantic). The on-device index ships in the linux-x64 package; on other targets
the setting is accepted but recall stays keyword-only. `memory-status` reports the current
mode and vector count, and `horde debug embedding-check` verifies the pipeline.
