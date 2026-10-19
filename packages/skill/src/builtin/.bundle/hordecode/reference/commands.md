# Hordecode Commands Reference

## CLI (`hordecode <command>`)

Invoked from the shell. `hordecode` with no command opens the TUI.

| Command | Purpose |
|---------|---------|
| `hordecode` | Launch the interactive TUI |
| `hordecode run` | Headless, non-interactive run (scripting/eval) |
| `hordecode mcp` | Manage / inspect MCP servers |
| `hordecode agent` | Manage agents |
| `hordecode models` | List available models |
| `hordecode providers` | List / manage providers |
| `hordecode account` (console) | Account / login console |
| `hordecode upgrade` | Update to the latest version |
| `hordecode uninstall` | Uninstall Hordecode |
| `hordecode serve` | Run the server |
| `hordecode stats` | Usage statistics |
| `hordecode export` / `hordecode import` | Export / import sessions |
| `hordecode session` | Manage sessions |
| `hordecode github` / `hordecode pr` | GitHub / pull-request integration |
| `hordecode generate` | Code generation entry |
| `hordecode plugin` (plug) | Manage plugins |
| `hordecode db` | Database utilities |
| `hordecode acp` / `hordecode attach` | ACP / attach to a running session |
| `hordecode debug` | Debug utilities |
| `hordecode completion` | Generate shell completion script |

Run `hordecode <command> --help` for flags on any command.

Notable TUI flags: `--continue`/`-c` (resume last session), `--session`/`-s`, `--model`/`-m`, `--agent`, `--never-ask`, `--trust`, and `--dangerously-skip-permissions` (auto-approve everything not explicitly denied; prompts once for confirmation — see permissions.md).

## Slash commands (inside the TUI)

| Command | Purpose |
|---------|---------|
| `/goal` | Set a stop condition; a judge model verifies it's truly met before the agent halts (prevents premature stops in autonomous work) |
| `/dream` | Scan recent traces, extract durable knowledge into project memory, prune stale entries |
| `/distill` | Detect repeated manual workflows and package high-confidence ones into skills/subagents/commands |
| `/loop` | `[interval] <prompt>` — schedule a repeating prompt (also runs once now); maps the interval to a cron job |
| `/loops` | List scheduled cron/loop jobs; `/loops cancel <id>` stops one |
| `/connect` | Sign in to a provider (e.g. OpenRouter) |
| `/<skill-name>` | Invoke any available skill directly by name |

## Keybindings

- `Tab` — cycle primary agents (build → plan → harness).
- Other keybinds are configurable; the keybinds config module governs them.

## Notes

- The web command is currently disabled; TUI is the supported interface.
