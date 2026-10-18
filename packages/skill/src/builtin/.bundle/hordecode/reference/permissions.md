# Hordecode Permissions Reference

Permissions decide what the agent may do without asking. Configure them under the top-level `permission` key.

## Actions

| Action | Meaning |
|--------|---------|
| `allow` | Run without prompting |
| `ask` | Prompt the user for confirmation |
| `deny` | Block entirely |

Defaults allow most tools. Hordecode asks for `external_directory` (paths outside the project, except its own temp, skill and reference dirs), `doom_loop` (the same call repeating) and reading `.env` files. Shell commands that delete files always ask (`bash_delete`): no `allow` rule pre-approves them, only `deny` blocks them.

## Two shapes

A rule is **either** a single action string, **or** a glob-keyed map of actions (for tools whose argument is a path or command):

```jsonc
{
  "permission": {
    // whole-tool action
    "webfetch": "allow",
    // glob-keyed: match on the tool's path/command argument.
    // Later rules win, so put the catch-all FIRST and specifics after it.
    "bash": {
      "*": "ask",
      "git *": "allow",
      "rm -rf *": "deny"
    }
  }
}
```

A bare string at the top level (`"permission": "allow"`) becomes `{ "*": action }`, a blanket default for everything.

## Configurable tools

Path/command-keyed (accept the glob-map form): `read`, `edit` (covers every file-writing tool), `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, `skill`, `supervisor` (patterns match the subagent type).

Action-only: `todowrite`, `question`, `webfetch`, `websearch`, `doom_loop`.

Other keys are accepted too, so custom and MCP tools can be named.

## Common recipes

Auto-allow read-only git and block destructive shell:
```jsonc
{ "permission": { "bash": { "git status": "allow", "git log *": "allow", "git diff *": "allow", "rm -rf *": "deny" } } }
```

Allow the system temp dir (opt-in; temp is world-writable):
```jsonc
{ "permission": { "external_directory": { "/tmp/**": "allow" } } }
```

Ask before every file edit:
```jsonc
{ "permission": { "edit": "ask" } }
```

## Auto mode (skipping permission prompts)

For trusted, disposable environments (containers, sandboxes, CI):

| Surface | How |
|---------|-----|
| TUI | `horde --auto`, or "Enable auto-approve permissions" in the command palette (`ctrl+p`) |
| Headless | `horde run --auto "<prompt>"` |

Auto mode answers every permission prompt with allow-once, including `ask` rules and `bash_delete`. `deny` rules still block, because a denied call never prompts. Without `--auto`, `horde run` rejects every permission prompt, so a headless run needs `--auto` or `allow` rules for what it must do.

`HORDECODE_PERMISSION` (JSON) is a different mechanism: it is merged into the `permission` config, and keys your config does not already have are appended last. With last-match-wins, `HORDECODE_PERMISSION='{"*":"allow"}'` therefore overrides earlier rules, including `deny` rules, when your config has no `*` key.

Auto mode is dangerous: a malicious prompt, file or plugin can then run commands without confirmation. Use it only where you fully trust the workspace.

## Notes

- Rules keep your insertion order and **the last matching rule wins**. Put the `*` catch-all **first**; a trailing `"*": "ask"` overrides every rule above it.
- `tools: { "<id>": false }` in config is the same as a `deny` rule for that tool.
- Never-ask (`/never-ask`) is separate: it makes the agent answer its own questions; permission prompts still ask.
