---
name: claude-code
description: Operate the Claude Code CLI (v2.1+) via the terminal — print mode (-p), interactive tmux sessions, and background (--bg) orchestration. Use only when the user explicitly requests Claude Code or names this skill.
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Claude Code CLI

Operate `claude` only when explicitly requested. It is a separate agent CLI; do not invoke it for general coding tasks.

## Modes

- Print mode (non-interactive): `claude -p "<prompt>" [--output-format stream-json]` for scripted single-shot work.
- Interactive: run inside a tmux session so the TUI survives; capture output with `tmux capture-pane`.
- Background: `claude --bg` starts an agent in the background; poll with `claude --resume <session-id>`.

## Session management

- Each `claude` run creates a session; capture the session id from the output for later resume.
- Prefer resuming an existing session over starting a new one when the work is a continuation.

## Verification

- Parse structured output (stream-json) to confirm completion; do not infer success from exit code alone.
- Kill tmux sessions when done (`tmux kill-session -t <name>`).
