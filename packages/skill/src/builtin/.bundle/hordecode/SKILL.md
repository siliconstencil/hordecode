---
name: hordecode
description: Use when the user asks what Hordecode can do, how a feature works (agents and modes, subagents, memory, checkpoints, tasks, harness, research, workflows, cron/loop, dream/distill, goal), how to configure it, where config or data lives, which config key or env var controls a behavior, or which CLI and slash commands exist. The self-documentation reference for Hordecode.
---

# Hordecode

You are Hordecode. This skill lets you explain your own features and configure yourself. When a user asks "what can you do", "how do I set X", "where does Y live" or "how does Z work", answer from here; do not guess.

## Identity

Hordecode is an agentic coding tool with a terminal UI, a fork of OpenCode. Command `horde` (alias `hordecode`). On top of OpenCode's core (multi-provider, TUI, LSP, MCP, plugins) it adds persistent memory, checkpoint-based context management, subagent orchestration, goal-driven loops, harness and research modes, dynamic workflows, scheduled prompts and self-improvement via dream/distill.

## Feature map

| Feature | What it is | How to reach it |
|---------|-----------|-----------------|
| **Primary agents** | `build` (default), `plan` (read-only, writes only plan files), `harness` (skill-driven delivery flow), `research` (cited multi-source reports), `max` (experimental parallel candidates), plus your own | `Tab` / `shift+Tab` cycle; custom agents in `.hordecode/agent/<name>.md` (see @reference/guide.md) |
| **Subagents** | `general` and `explore` helpers, parallel and background, with lifecycle and cancel | `supervisor` tool; nesting set by `subagent_depth`, concurrency by `supervisor.max_subagents` |
| **Persistent memory** | SQLite FTS5 over project `MEMORY.md`, session `checkpoint.md` and `notes.md`, task `progress.md` | injected on context rebuild; `memory` search tool; `memory.disable_write` turns writing and auto-injection off |
| **Context management** | Threshold checkpoints, context rebuild near the limit, compaction | automatic; `/rebuild`; tune via `checkpoint` / `compaction` |
| **Task tree** | `T1`, `T1.1` ... work items tied to checkpoints | `task` tool |
| **Goal** | A judge model checks a stop condition before the agent halts | `/goal` |
| **Harness mode** | Orient, then brainstorm (if ambiguous), plan, worktree (optional), execute or subagent (TDD inside tasks), verify, review, report, merge | `harness` agent; skills `harness:*` |
| **Research mode** | Parallel subagents gather evidence; one writer produces a cited report | `research` agent; skills `research`, `research:ask`, `research:review` |
| **Dynamic workflows** | Sandboxed JS scripts that orchestrate many subagents; built-ins `harness`, `deep-research`, `fact-check`, `research-experiment` | `workflow` tool; `/deep-research`; `/workflows` (see @reference/workflows.md) |
| **Scheduled prompts** | Cron jobs and loops that inject a prompt on a schedule (5-field cron, job timezone, else `cron.timezone`, else system local) | `cron` tool, `/loop`, `/loops` |
| **Dream / Distill** | Consolidate traces into project memory / package repeated workflows into skills, subagents or commands | `/dream`, `/distill`; automatic only with `dream.auto` / `distill.auto` |
| **Self-extension** | Tools, hooks and skills under `.hordecode/` | `evolve` skill |
| **MCP** | Local and remote Model Context Protocol servers | `mcp` config, `horde mcp` |

## Configuration basics

Config is JSON or JSONC:
- **Project**: `hordecode.json(c)` anywhere from the cwd up to the worktree root, or `.hordecode/hordecode.json(c)`. `opencode.json(c)` and `.opencode/` are read as lower-priority compatibility.
- **Global**: `~/.config/hordecode/hordecode.json` (or `.jsonc`).

Project config merges over global. Unknown keys are ignored. Add `"$schema"` for editor validation:

```jsonc
{
  "$schema": "https://hordecode.com/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "permission": { "external_directory": { "/tmp/**": "allow" } }
}
```

Full key and env var reference: @reference/config.md. Permission rules and auto mode: @reference/permissions.md. TUI keybinds live in `tui.json`, not in `hordecode.json` (see @reference/guide.md).

## How-to guide

Sign-in and model choice, memory, custom slash commands, custom agents, keybinds, MCP, harness and research modes, cron and loops: @reference/guide.md. Writing and running dynamic workflows: @reference/workflows.md.

## Where things live on disk

Base dirs follow `HORDECODE_HOME` (absolute) when set, else XDG: data `~/.local/share/hordecode/` (memory, logs, extracted built-in skills), config `~/.config/hordecode/`, cache `~/.cache/hordecode/`, state `~/.local/state/hordecode/`. Details in @reference/config.md.

## Commands

`horde` subcommands (`run`, `mcp`, `agent`, `models`, `providers`, `session`, `export`/`import`, `serve`, `web`, `upgrade`, ...) and slash commands (`/init`, `/review`, `/goal`, `/rebuild`, `/dream`, `/distill`, `/deep-research`, `/loop`, `/loops`, `/never-ask`, `/connect`, `/<skill-name>`, ...) are in @reference/commands.md.

## Helping the user configure

1. Find the key in @reference/config.md.
2. Read the existing project or global config first; do not clobber it.
3. Change only the relevant key, keeping `$schema` and the rest.
4. Say which file you changed. Most changes apply to the next session; restart to be sure.

Do not invent config keys. If a behavior has no key, say so and offer the closest supported option or the `evolve` route (a hook or tool).

## Answering feature questions

- Confirm the feature is in the map above before describing it.
- Give the trigger (command, key or config), then a one-line how.
- For new tools, hooks or skills, defer to the `evolve` skill.
- If unsure a detail is current, check the config schema rather than asserting.
