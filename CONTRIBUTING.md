# Contributing to Hordecode

We want to make it easy for you to contribute to Hordecode. Here are the most common types of changes that get merged:

- Bug fixes
- Additional LSPs / Formatters
- Improvements to LLM performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

However, any UI or core product feature must go through a design review with the core team before implementation.

## Developing Hordecode

- Requirements: Bun 1.3.14 or later
- Install dependencies and start the dev server from the repo root:

  ```bash
  bun install
  bun dev
  ```

### Running against a different directory

By default, `bun dev` runs Hordecode in the current working directory. To run it against a different directory:

```bash
bun dev /path/to/directory
```

### Building a standalone binary

To compile a standalone executable for your platform:

```bash
cd packages/opencode
bun run script/build.ts --single
```

Then run it with:

```bash
./packages/opencode/dist/hordecode-<os>-<arch>/bin/hordecode
```

Replace `<os>-<arch>` with your platform (e.g., `linux-x64`, `darwin-arm64`). A `horde` alias symlink (or copy on Windows) is created alongside the binary.

To build for a specific target, use `--target`:

```bash
cd packages/opencode
bun run script/build.ts --target linux-x64
bun run script/build.ts --target linux-x64-baseline
```

Accepted target names are listed in `packages/opencode/script/build.ts` (the `allTargets` table).

### Core architecture

- `packages/opencode`: Hordecode core business logic and CLI server
- `packages/opencode/src/cli/cmd/tui/`: The TUI code, written in SolidJS with opentui
- `packages/app`: Shared web UI components, written in SolidJS
- `packages/desktop`: Native desktop app, built with Electron (wraps `packages/app`)
- Fork-specific packages: agent, bus, control-plane, cron, global, inbox, memory, project, shared, skill, supervisor, task, team, workflow, worktree

### Type checking and testing

Tests cannot run from repo root (guard: `do-not-run-tests-from-root` in bunfig.toml). Run from package directories instead:

```bash
cd packages/opencode
bun run typecheck
bun test
```

For a quick overview of available per-package commands, see TOOLBOX.md.

### Setting up a Debugger

Bun debugging is rough around the edges. The most reliable way is to run Hordecode manually with `bun run --inspect=<url>` and attach your debugger via that URL.

Caveats:

- If you want to run the Hordecode TUI and have breakpoints triggered in the server code, you might need to run `bun dev spawn` instead of
  the usual `bun dev`. This is because `bun dev` runs the server in a worker thread and breakpoints might not work there.
- If `spawn` does not work for you, you can debug the server separately:
  - Debug server: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096`,
    then attach TUI with `horde attach http://localhost:4096`
  - Debug TUI: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts`

Other tips:

- Consider `--inspect-wait` or `--inspect-brk` instead of `--inspect`, depending on your workflow
- `export BUN_OPTIONS=--inspect=ws://localhost:6499/` avoids repeating the URL on every invocation

#### VSCode Setup

If you use VSCode, configure debugging with [.vscode/settings.example.json](.vscode/settings.example.json) and [.vscode/launch.example.json](.vscode/launch.example.json).

Some debug configurations can map breakpoints incorrectly and render them unusable:

- Debug configurations with `"request": "launch"`
- Running Hordecode in the VSCode JavaScript Debug Terminal

## Pull Request Expectations

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### UI Changes

If your PR includes UI changes, please include screenshots or videos showing the before and after. This helps maintainers review faster.

### Logic Changes

For non-UI changes (bug fixes, new features, refactors), explain how you verified it works:

- What did you test?
- How can a reviewer reproduce or confirm the fix?

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions are not acceptable and may be ignored. Respect maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you cannot explain it briefly, your PR might be too large

### PR Titles and Conventional Commits

PR titles should follow conventional commit standards. Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful (e.g., `core`, `opencode`, `tui`, `app`, `desktop`).

Examples:

- `docs: update contributing guide`
- `fix: resolve crash on startup`
- `feat(tui): add session replay`
- `chore(opencode): bump dependency versions`

## Code Style and Standards

Refer to AGENTS.md for the complete style guide and commit conventions. Key principles include:

- Keep logic in one function unless breaking it out adds reuse or clarity
- Avoid `try`/`catch`; prefer early returns and `.catch(...)`
- Use `const` and avoid unnecessary `let`
- Reach for precise types; avoid `any`
- Use Bun helpers like `Bun.file()` when they fit

## Feature Requests

For net-new functionality, start with a design conversation. Open an issue describing the problem, your proposed approach (optional), and why it belongs in Hordecode. The core team will help decide whether it should move forward; please wait for approval before opening a feature PR.
