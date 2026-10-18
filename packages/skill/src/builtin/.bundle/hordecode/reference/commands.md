# Hordecode Commands Reference

## CLI (`horde <command>`, alias `hordecode`)

`horde` with no command opens the TUI in the current directory (`horde <path>` opens it there).

| Command | Purpose |
|---------|---------|
| `horde run "<prompt>"` | Headless, non-interactive run (scripting, CI) |
| `horde mcp` | Manage MCP servers: `list`, `add`, `auth`, `logout`, `debug` |
| `horde agent` | `create` a new agent file, `list` loaded agents |
| `horde models [provider]` | List available models (`--refresh` updates the models cache) |
| `horde providers` (alias `auth`) | `list`, `login`, `logout` providers and credentials |
| `horde session` | List, delete and import sessions (including imports from Claude Code, Codex and opencode) |
| `horde export` / `horde import` | Export a session as JSON / import one |
| `horde serve` | Run the headless server |
| `horde web` | Start the server and open the web interface |
| `horde attach <url>` | Attach the TUI to a running server |
| `horde acp` | Run as an Agent Client Protocol server |
| `horde github` | `install` / `run` the GitHub agent |
| `horde pr <number>` | Check out a GitHub PR branch, then start Hordecode |
| `horde plugin <module>` (alias `plug`) | Install a plugin and add it to config |
| `horde stats` | Token and cost statistics |
| `horde db` | Open the SQLite database shell, run a query, or print its `path` |
| `horde debug` | Debugging and troubleshooting tools |
| `horde upgrade` / `horde uninstall` | Update / remove Hordecode |
| `horde completion` | Generate a shell completion script |

Run `horde <command> --help` for the flags of any command.

Notable TUI flags: `--continue`/`-c` (resume the last session), `--session`/`-s <id>`, `--fork` (with `-c`/`-s`), `--prompt`, `--model`/`-m provider/model`, `--agent`, `--trust` (skip the workspace trust prompt), `--mini` (minimal interface), and `--auto` (approve permission prompts; explicit `deny` rules still block; see @permissions.md). `horde run` accepts `--auto` too.

## Slash commands (inside the TUI)

| Command | Purpose |
|---------|---------|
| `/init` | Guided `AGENTS.md` setup |
| `/review` | Review changes (`commit`, `branch` or `pr`; defaults to uncommitted) |
| `/goal` | Set a stop condition; a judge model checks it before the agent halts. `/goal clear` aborts |
| `/rebuild` | Rebuild context now from the latest checkpoint (frees context, keeps recent messages) |
| `/dream` | Consolidate project memory from memory files and recent traces |
| `/distill` | Find repeated workflows and package them into skills, subagents or commands |
| `/deep-research` | Multi-source, fact-checked research report (runs the `deep-research` workflow) |
| `/loop` | `[interval] <prompt>`: schedule a repeating prompt (also runs once now) |
| `/loops` | List scheduled jobs; `/loops cancel <id>` deletes one |
| `/workflows` | Open the workflow runs page |
| `/never-ask` | Toggle never-ask: the agent picks the best option instead of asking questions (permission prompts still ask) |
| `/connect` | Connect a provider (API key or OAuth) |
| `/models`, `/agents`, `/sessions`, `/new`, `/mcps`, `/themes`, `/help`, `/exit` | Pickers and session basics |
| `/<skill-name>` | Invoke any available skill by name |

The command palette (`ctrl+p`) lists every command, including "Enable auto-approve permissions".

## Keybindings

- `Tab` / `shift+Tab`: cycle primary agents (build, plan, harness, research, max, plus custom primary agents).
- Leader key `ctrl+x`. Remap any binding under `keybinds` in `tui.json` (see @guide.md).
