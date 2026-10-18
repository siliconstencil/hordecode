# Hordecode Configuration Reference

## File locations & precedence

Config is JSON or JSONC. Later sources override earlier ones:

1. Global: `~/.config/hordecode/hordecode.json` or `.jsonc` (XDG config dir; `opencode.json(c)` there is read first as compatibility).
2. Project: `hordecode.json(c)` in any directory from the cwd up to the worktree root (`opencode.json(c)` read first as compatibility).
3. `.hordecode/hordecode.json(c)` in the project tree (and in `~/.hordecode/`).
4. `$HORDECODE_CONFIG_DIR`: an extra config directory; its `opencode.json(c)`, agents, commands and plugins are loaded.

Unknown keys are ignored. Always include `"$schema": "https://hordecode.com/config.json"` for validation.

TUI settings (keybinds, theme) live in a separate `tui.json` / `tui.jsonc` (project tree, `.hordecode/`, or `~/.config/hordecode/`); see @guide.md.

## On-disk data layout

Base directories resolve from `HORDECODE_HOME` if set (must be absolute; gives `<home>/{data,cache,config,state}`), otherwise from XDG:

| Kind | Default location | Holds |
|------|------------------|-------|
| data | `~/.local/share/hordecode/` | `memory/`, `log/`, `builtin_skills/<version>/`, `repos/`, `hordecode.db` (sessions) |
| config | `~/.config/hordecode/` | global `hordecode.json`, `tui.json`, global agents and commands |
| cache | `~/.cache/hordecode/` | `bin/` (downloaded tools), `models/` |
| state | `~/.local/state/hordecode/` | runtime state |

Memory files live under `~/.local/share/hordecode/memory/`:
- `projects/<project-id>/MEMORY.md`: project memory
- `sessions/<id>/checkpoint.md`, `notes.md`, `tasks/<id>/progress.md`
- `global/MEMORY.md`: cross-project user preferences

## Environment variables

`HORDECODE_*` names win; the matching `OPENCODE_*` names are read as fallback.

- `HORDECODE_HOME`: override all base dirs (absolute path).
- `HORDECODE_CONFIG_DIR`: extra config directory (see above).
- `HORDECODE_PERMISSION`: JSON merged into `permission`; keys new to your config are appended last (see @permissions.md).
- `HORDECODE_PURE`: run without external plugins (same as `horde --pure`).
- `HORDECODE_DISABLE_PROJECT_CONFIG`: ignore project config files.
- `HORDECODE_DISABLE_CLAUDE_CODE`: do not read Claude Code prompts (`CLAUDE.md`) or skills; `HORDECODE_DISABLE_CLAUDE_CODE_PROMPT` / `_SKILLS` turn off one side.
- `HORDECODE_DISABLE_EXTERNAL_SKILLS`: load no skills from `.claude/` and `.agents/` skill folders.
- `HORDECODE_DISABLE_CRON`: stop scheduled jobs from firing.
- `HORDECODE_DISABLE_LOG_ROTATION`: keep one growing log file instead of rotating.

## Top-level config keys

All optional.

### Models & providers
| Key | Purpose |
|-----|---------|
| `model` | Primary model as a literal `provider/model`, e.g. `anthropic/claude-sonnet-4-5` |
| `small_model` | Literal `provider/model` for cheap tasks (title generation etc.). If unset, cheap tasks use the `lite` group, else the default model |
| `vision_model` | `provider/model` for image tasks; if unset, a vision-capable model is chosen automatically |
| `model_groups` | Named model tiers, see [Model groups](#model-groups) |
| `provider` | Custom provider configs & model overrides |
| `enabled_providers` / `disabled_providers` | Allowlist / blocklist providers |

### Model groups

`model_groups` defines named tiers. A group name resolves in: the `supervisor` tool `model` argument, the `session` tool `model` argument, a workflow `agent({ model })` option, and the cheap-task slot (`lite`). The top-level `model`, agent `model` and command `model` take a literal `provider/model`.

Each group is a single default model (string) or an object with a `default` plus member `models`:

```jsonc
{
  "$schema": "https://hordecode.com/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "model_groups": {
    // string shorthand: the group IS its default model
    "lite": "anthropic/claude-haiku-4-5",
    // object form: a default plus alternates on other providers
    "standard": {
      "default": "anthropic/claude-sonnet-4-5",
      "models": ["anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-sonnet-4.5"]
    }
  }
}
```

Resolution rules:
- A ref containing `/` is a literal `provider/model`, used as-is.
- A ref without `/` is a group name. Hordecode prefers a member on the caller's current provider, else the group's `default`.
- `ultra`, `standard`, `lite` are built-in tier names: unconfigured, they fall back to the default model.
- Any other unconfigured name errors with suggestions (a workflow `agent()` falls back to the run's model instead).

### Agents
| Key | Purpose |
|-----|---------|
| `default_agent` | Primary agent when none is specified (falls back to `build`) |
| `agent` | Per-agent config: `build`, `plan`, `general`, `explore`, `title`, `summary`, `compaction`, plus custom; fields as in the agent frontmatter (@guide.md) |
| `subagent_depth` | Subagent nesting depth (default 3, capped at 8; 1 keeps subagents from launching subagents) |
| `supervisor.max_subagents` | Subagents the supervisor tool runs at once in one session tree (default 8, capped at 16) |
| `username` | Display name in conversations |

Prefer a markdown file (`.hordecode/agent/<name>.md`, body = system prompt) for a custom agent; see @guide.md.

### Tools, skills, MCP, extensions
| Key | Purpose |
|-----|---------|
| `skills` | `paths[]` extra skill folders + `urls[]` remote skill indexes |
| `mcp` | MCP servers: `local` (command/environment) or `remote` (url/headers/oauth); `{ "enabled": false }` disables one |
| `tools` | Record of tool-id to boolean; `false` becomes a `deny` permission |
| `tool_output` | `max_lines` (default 2000) / `max_bytes` (default 51200) before output is truncated and saved to disk |
| `shell` | Default shell for the terminal and the shell tool |
| `command` | Custom slash commands |
| `plugin` | Plugin specs |
| `formatter`, `lsp` | Formatter & language-server config |
| `instructions` | Extra instruction files/globs to include |
| `permission` | Permission rules (@permissions.md) |

### Context management
| Key | Purpose |
|-----|---------|
| `compaction.auto` | Auto-compact when context is full (default true) |
| `compaction.prune` | Prune old tool outputs (default false) |
| `compaction.tail_turns` | Recent user turns kept verbatim (default: unset, limited by `preserve_recent_tokens`) |
| `compaction.preserve_recent_tokens` | Max recent tokens kept verbatim |
| `compaction.reserved` | Token buffer to avoid overflow |
| `compaction.max_context` | Compact earlier than the model window: `300000`, `"300K"`, `"50%"`, or a map keyed by `provider/model` (wildcards allowed) |
| `checkpoint.thresholds` | Context-fill triggers, e.g. `["40%","60%","80%"]` |
| `checkpoint.reserved` | Token buffer for checkpoint ops (default 20000) |
| `checkpoint.fork` | Fork the parent prefix into the writer session for cache reuse (default false) |
| `checkpoint.push_caps.*` | Per-section token caps for the rebuilt context (tasks_ledger, focus_task, checkpoint, memory, notes, global, recent_user, ...) |
| `checkpoint.task_archive_days` | Days before done/abandoned tasks are filtered out (default 7) |
| `checkpoint.memory_search_score_floor` | Relative BM25 floor for memory search (default 0.15) |
| `memory.disable_write` | Stop writing memory and its automatic injection; existing memory stays searchable (default false) |
| `memory.embedding` | Semantic memory search; downloads a ~133 MB model into the cache on first use (default false) |
| `memory.cc_index` | Index Claude Code memory under scope `cc` (default false; see the privacy note in the schema) |
| `history.kinds` | Part kinds covered by the conversation-history index |

### Autonomous / self-improvement
| Key | Purpose |
|-----|---------|
| `dream.auto` / `dream.interval_days` | Automatic memory consolidation on session start (default false / 7 days) |
| `distill.auto` / `distill.interval_days` | Automatic workflow packaging on session start (default false / 30 days) |
| `harness.docs` | Directory for harness specs, plans and reports, and research workspaces (default `docs/harness`); `harness.docs_absolute: true` anchors a relative path to the worktree root |
| `workflow.maxConcurrentAgents` | Process-wide subagent concurrency ceiling for workflows (default min(16, 2x cores)) |
| `workflow.scriptDeadlineMs` | Wall-clock budget for one workflow script (default 43200000, 12 h) |
| `cron.timezone` | Default IANA timezone for cron jobs (default: system local timezone) |

### Experimental
| Key | Purpose |
|-----|---------|
| `experimental.maxMode` | Enables parallel candidates for the `max` agent: N candidates per step, a judge picks the winner (`candidates`, default 5) |
| `experimental.continue_loop_on_deny` | Keep looping when a tool call is denied |
| `experimental.mcp_timeout` | Default MCP request timeout (ms) |

### Misc
| Key | Purpose |
|-----|---------|
| `autoupdate` | `true` / `false` / `"notify"` |
| `snapshot` | Filesystem snapshot tracking for undo/redo (default true) |
| `logLevel` | Log verbosity |
| `server` | Config for `horde serve` / `horde web` |
| `enterprise.url` | Enterprise endpoint |

## Example: common tweaks

```jsonc
{
  "$schema": "https://hordecode.com/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "model_groups": { "lite": "anthropic/claude-haiku-4-5" },
  "dream": { "auto": true, "interval_days": 3 },
  "compaction": { "tail_turns": 3 },
  "permission": { "external_directory": { "/tmp/**": "allow" } },
  "mcp": {
    "my-server": { "type": "local", "command": ["node", "server.js"] }
  }
}
```
