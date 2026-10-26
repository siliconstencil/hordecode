---
name: drive-hordecode
description: Programmatically drive another Hordecode process — headless `hordecode run` with JSON events and interactive TUI via tmux for full terminal interaction testing. Covers driving an installed `hordecode` binary or a dev build launched from source with `bun dev` (for debugging hordecode itself).
version: 1.0.0
license: MIT
platforms: [linux, macos]
---

# Driving a Hordecode process

Drive another hordecode process to script, test, or automate it and validate its behavior from parseable evidence. Use this skill to automate a separate hordecode instance end to end.

## Two Interfaces

- Headless: `hordecode run --format json` — scripted runs, CI, event validation. Every step emits a JSON event stream.
- TUI: `hordecode` inside tmux — interactive flows, permission dialogs, keybindings, visual regression. Capture panes with `tmux capture-pane`.

## Core Principle

Every run produces parseable evidence. No eyeballing. Assert against the JSON event stream or captured pane text; never judge by watching.

## Isolation

Always drive an ISOLATED instance: fresh `HORDECODE_HOME` plus a throwaway workspace. Never drive a shared home; state leaks between runs invalidate evidence.

## Launcher Axis

The launcher choice is orthogonal to the interface:

- Installed binary: `hordecode ...` (same flags, events, and tmux behavior)
- Dev build: `bun dev ...` from the repo root (packages/opencode/src/index.ts, no build step; local edits take effect on next launch)

## Prerequisites

- `which hordecode` (or repo with bun) and `which tmux` before starting.
- Helper scripts must be invoked with `bash scripts/wait-for-text.sh ...` — they are not executable.
- Wait for pane text with `bash scripts/wait-for-text.sh -t <session>:0.0 -p '<regex>' -T <seconds>` (exit 0 when the text appears, 1 on timeout); it needs bash and tmux, so it is POSIX-only (Linux and macOS, not native Windows).

## Dev Mode

`bun dev` runs the source directly. There is no build step; a local edit is live on the next launch. Use this when debugging hordecode itself.

## Verification

- Headless: assert the expected JSON events appear in order, then assert terminal state.
- TUI: `tmux capture-pane -pt <session>` and grep for expected text; kill the session when done.
