# Hordecode Usage Guide

How-to for the features users most often ask about. Config keys: @config.md. Permissions: @permissions.md. Commands: @commands.md.

## Getting started & auth

1. **Connect a provider**: `/connect` in the TUI, or `horde providers login` (alias `horde auth login`) in the shell. Provider API keys in environment variables are detected automatically.
2. **Pick a model**: set `"model": "provider/model"` in config, pass `-m provider/model`, or switch live with `/models`.
3. **List what's available**: `horde models`, `horde providers list`.

## Memory: making Hordecode remember

Memory persists across sessions and is brought back when context is rebuilt, so the agent does not relearn the project.

- **Project rules / architecture**: project memory is `~/.local/share/hordecode/memory/projects/<project-id>/MEMORY.md`. Durable rules go under `## Rules`, design decisions under `## Architecture decisions`. The quickest way: tell the agent the rule; it can write it there.
- **`/dream`**: promotes durable knowledge from recent traces into `MEMORY.md` and prunes stale entries. It runs automatically only with `dream.auto: true`, at most every `dream.interval_days` (default 7).
- **Checkpoints** (`checkpoint.md`) are written only by the checkpoint-writer subagent; do not hand-edit them. `/rebuild` rebuilds context from the latest checkpoint.
- **Scratch notes** (`notes.md`) are the agent's free-form scratchpad.
- The `memory` tool searches all of it.

Tune with `checkpoint.*`, `compaction.*` and `memory.*` (see @config.md).

## Custom slash commands

Drop a markdown file at `.hordecode/command/<name>.md` (or `commands/`; `~/.config/hordecode/command/` for global). The frontmatter configures it; the body is the prompt template.

```markdown
---
description: Review the current diff for security issues
agent: build
subtask: false
---
Review the staged diff. Focus on: $ARGUMENTS
```

- Invoke with `/name your args here`.
- Placeholders: `$ARGUMENTS` (all args), `$1`, `$2`, ... (positional; the highest one takes the rest). With no placeholder, args are appended.
- Frontmatter: `description`, `agent` (which agent runs it), `model` (a literal `provider/model`), `variant`, `subtask: true` (run as a subagent).

## Custom agents & modes

A "mode" is a **primary agent** with its own system prompt. Drop a markdown file; the frontmatter is config and the **body becomes the system prompt**.

```markdown
---
description: A friendly general-purpose assistant for everyday chat and Q&A
mode: primary
temperature: 0.7
---
You are "Chat", a warm, concise, general-purpose assistant.
Keep replies short unless asked to elaborate; you are not focused on coding.
```

| Path | Scope |
|------|-------|
| `.hordecode/agent/<name>.md` (or `agents/`) | project agent, most common |
| `.hordecode/mode/<name>.md` (or `modes/`) | project mode: an agent forced to `mode: primary` |
| `~/.config/hordecode/agent/<name>.md` | global agent, available in every project |

Frontmatter fields (all optional):

- `mode`: `primary` (selectable with `Tab`), `subagent` (launched through the `supervisor` tool, listed in `@` autocomplete), or `all`.
- `model`: a literal `provider/model`; `variant`, `temperature`, `top_p` tune generation.
- `description`: when to use it.
- `permission` (rules as in @permissions.md), `steps` (max agentic iterations), `color`, `hidden`, `disable`, `options`.

For a primary agent the body replaces the default base prompt; environment, skills and instruction blocks are still appended. The selection is per session: the TUI `Tab` picker, `--agent <name>`, or the `agent` field on `session.prompt` over the SDK.

Check it loaded with `horde agent list` (shows `(primary)` / `(subagent)`). Short overrides can go inline under the `agent` config key (`agent.<name>.prompt`, `model`, `mode`, ...).

## Keybinds

Keybinds live in `tui.json` (project tree or `.hordecode/`) or `~/.config/hordecode/tui.json`, under `keybinds`. The leader key is `ctrl+x`, so `<leader>n` means "press ctrl+x, then n".

Defaults include: `Tab` / `shift+Tab` cycle agents, `ctrl+p` command palette, `<leader>n` new session, `<leader>l` list sessions, `<leader>c` compact, `<leader>e` external editor, `<leader>t` themes, `<leader>b` toggle sidebar, `ctrl+r` rename session. Set a binding to `"none"` to disable it.

```jsonc
// ~/.config/hordecode/tui.json
{ "keybinds": { "session_new": "<leader>o", "sidebar_toggle": "none" } }
```

## MCP servers

Add servers under the `mcp` key:

```jsonc
{
  "mcp": {
    // local: spawn a process over stdio
    "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
    // remote: HTTP endpoint (OAuth auto-detected; set "oauth": false to turn it off)
    "docs": { "type": "remote", "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer ..." } },
    // disable one without deleting it
    "old": { "enabled": false }
  }
}
```

Manage with `horde mcp` (`list`, `add`, `auth`, `logout`, `debug`) or `/mcps` in the TUI. Connecting times out after 30 s by default; set `timeout` per server, and `experimental.mcp_timeout` for a default request timeout.

## Harness mode

The `harness` agent (`Tab` to it) runs a skill-driven delivery flow. It orients first (repository, instructions, recent changes), then runs only the stages the work needs:

1. `harness:brainstorm` (only when requirements are ambiguous)
2. `harness:plan`
3. `harness:worktree` (optional isolation)
4. `harness:execute` inline, or `harness:subagent` (fresh subagent per task), with `harness:tdd` inside each task
5. `harness:verify`, then `harness:review`
6. `harness:report`, then `harness:merge` (offers finishing options)

`harness:debug`, `harness:feedback`, `harness:parallel` and `harness:ask` are loaded when needed. Decisions go through the `question` tool. Unattended (no user, or `/never-ask`), it picks options itself and ends with a report: it never merges, pushes, opens a PR or deletes work.

Specs, plans and reports go to `specs/`, `plans/`, `reports/` under the harness docs dir (`harness.docs`, default `docs/harness`).

For a fire-and-forget run, the `harness` built-in workflow drives the same flow non-interactively (see @workflows.md).

## Research mode

The `research` agent answers questions that need several independent sources with a cited report. It loads the `research` skill: triage, scope (one clarifying question at most, via `research:ask`), parallel subagent gathering, evidence audit (`research:review`), then a single-writer report and a short summary. Simple lookups get a direct, sourced answer instead.

The workspace is `<harness docs dir>/reports/<YYYY-MM-DD>-<slug>/` (brief, findings, report). `/deep-research` runs the `deep-research` workflow instead.

## Jupyter notebooks

The `notebook_edit` tool edits `.ipynb` cells directly (replace, insert or delete one cell) and keeps the surrounding JSON, outputs and metadata; prefer it over raw text edits on notebooks.

## Scheduled prompts (cron) & loops

**Cron** injects a prompt into a session on a recurring or one-shot schedule, driven by the `cron` tool. `HORDECODE_DISABLE_CRON=1` stops jobs from firing.

| Verb | Purpose |
|------|---------|
| `schedule` | Add a job: `cron` (5-field), `prompt`; optional `name`, `timezone`, `one_shot`, `durable`, `permanent`, `shell` (run a command instead of a prompt), `session_id` |
| `loop` | Arm a repeating loop: `delay_seconds` (clamped 60-3600), `prompt`; optional `name`, `reason`, `shell` |
| `list` | List jobs (filter by `kind`, `durable_only`) |
| `get` | Show one job by `id` or `name` |
| `rename` | Replace a job's prompt body |
| `setName` | Set a job's display name |
| `delete` (alias `cancel`) | Remove a job by `id` or `name` |

- **Expressions** are 5-field (`minute hour dom month dow`), evaluated in the job `timezone`, else `cron.timezone`, else the system local timezone.
- **Durable** jobs persist to `<project>/.hordecode/scheduled_tasks.json` and survive restart; others live only for the session.
- **Lifetime**: loops and recurring jobs stop after 7 days; a recurring `schedule` job with `permanent: true` keeps running.
- A fired prompt arrives with a `[cron fire @ <ISO>]` prefix, and the TUI shows a cron-fire row before the reply.

**Loop**: `/loop [interval] <prompt>` (a built-in skill) parses an interval (`30m`, `2h`), maps it to a recurring job and also runs the prompt once now. `/loops` lists jobs; `/loops cancel <id>` stops one.

`/loop` (cadence) and `/goal` (stop condition) are independent: `/goal` decides *whether* the agent may stop; `/loop` decides *how often* it runs.

## Extending Hordecode

To add tools, hooks or skills, use the `evolve` skill: it covers `.hordecode/tools/*.ts`, `.hordecode/hooks/*.ts` and `.hordecode/skills/<name>/SKILL.md`.
