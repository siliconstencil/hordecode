---
name: codex
description: Run, configure, and troubleshoot OpenAI Codex CLI in non-interactive headless environments (Bash/PowerShell, native Windows or WSL2, CI/CD, Docker/K8s, remote servers, agent harnesses, batch jobs). Covers constructing `codex exec` commands, sandbox/approval modes, JSONL and structured output, resuming sessions, stdin prompts, and handling `request_user_input` failures.
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Codex CLI (headless)

Operate OpenAI Codex CLI headlessly. Use this skill whenever a task needs `codex exec` driven from a script, CI pipeline, container, or another agent — never the interactive TUI.

## Operating Rules

- Use `codex exec` for every headless invocation. The TUI (`codex`) is interactive and not scriptable.
- Pass the task as the positional PROMPT argument, NOT as `-p`. `-p` selects a profile.
- Canonical command shape: `codex exec -C /repo --sandbox workspace-write --ask-for-approval never "<TASK>"`
- `--yolo` (no sandbox) is allowed ONLY in a hardened disposable runner (fresh container/VM) that enforces the boundary itself.
- Use `--json` and `--output-last-message` for harnesses and CI so the final assistant message is machine-readable.
- Never depend on a human answering prompts mid-run: use `--ask-for-approval never` and design the task so `request_user_input` failures are handled by the caller.
- Inject `CODEX_API_KEY` as an env var scoped to the single process; never write it into config or logs.
- Run `codex exec --help` before giving version-sensitive advice — flags drift between releases.

## Execution Modes

- Read-only analysis: `--sandbox read-only --ask-for-approval never`
- Workspace-scoped implementation (default): `--sandbox workspace-write --ask-for-approval never`
- Externally isolated unrestricted: `--yolo` — only when the container/VM enforces the isolation boundary.

## Windows

- Pick ONE environment per task: native PowerShell or WSL2. Mixing the two breaks path resolution and env inheritance.
- In WSL2, run `codex` from inside the WSL distro; do not invoke Windows-installed binaries from WSL or vice versa.

## Verification

- Assert `codex exec --version` before scripting long runs.
- For CI: capture `--json` output, parse the last message, and fail the job when `request_user_input` or a non-zero exit is present.
