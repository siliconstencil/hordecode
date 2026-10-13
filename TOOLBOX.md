# Developer Toolbox

Quick reference for common development commands in Hordecode. See CONTRIBUTING.md for setup and detailed guidance.

## Per-Package Commands

Tests and type checking must run from package directories (root is banned in bunfig.toml):

```bash
cd packages/opencode
bun run typecheck
bun test
```

Substitute `opencode` with `core`, `agent`, `tui`, `skill`, etc. Most packages follow the same pattern:

- `bun run typecheck`: Run TypeScript type check (tsc --noEmit)
- `bun test`: Run the test suite

Special case — packages/opencode has two test phases:

```bash
cd packages/opencode
bun test --timeout 30000 --path-ignore-patterns '**/server-credential-strip.test.ts'
bun test --timeout 30000 test/lsp/server-credential-strip.test.ts
```

## Build Commands

Build standalone binaries (run from `packages/opencode`):

```bash
cd packages/opencode
bun run script/build.ts --single
```

Output: `packages/opencode/dist/hordecode-<os>-<arch>/bin/hordecode` + `horde` symlink (or copy on Windows).

Build specific targets:

```bash
bun run script/build.ts --target linux-x64
bun run script/build.ts --target linux-x64-baseline
bun run script/build.ts --target darwin-arm64
```

Accepted target names are the `allTargets` table in `packages/opencode/script/build.ts`.

Flags:

- `--single`: Current platform only (default for local dev)
- `--baseline`: Non-AVX2 variant (skipped by default in --single)
- `--target <name>`: Build one specific target
- `--skip-install`: Skip multiplatform dependency fetch
- `--sourcemaps`: Emit sourcemaps (default: none)
- `--skip-embed-web-ui`: Skip web UI embedding

## Development Server

Run from repo root:

```bash
bun dev                        # Start TUI in current directory
bun dev /path/to/project       # Start TUI in specific directory
bun dev serve                  # Start headless API server on port 4096
bun dev serve --port 8080      # Custom port
bun dev web                    # Start server + open web UI at http://localhost:5173
```

## Web and Desktop Apps

Requires separate terminal with `bun dev serve` running first:

```bash
bun run --cwd packages/app dev        # Web app dev server (http://localhost:5173)
bun run --cwd packages/desktop dev    # Desktop app (Electron)
bun run --cwd packages/desktop build  # Build production package
```

## Debug Commands

Debug subcommands (root or `bun dev`):

```bash
horde debug paths              # Show global paths (data, config, cache, state)
horde debug info               # Show version, OS, terminal, plugins
horde debug embedding-check    # Verify memory embedding pipeline (120s timeout, no-op if disabled)
horde debug config             # Debug configuration loading
horde debug lsp                # Debug LSP integration
horde debug file               # Debug file operations
horde debug skill              # Debug skill loading
horde debug snapshot           # Debug snapshot handling
horde debug startup            # Debug startup flow
horde debug agent              # Debug agent execution
horde debug v2                 # Debug V2 session core
```

See packages/opencode/src/cli/cmd/debug/index.ts for all available subcommands.

The `embedding-check` command requires `memory.embedding: true` in config. It waits up to 120s for the model to download and initialize (first cold run is slower). Returns JSON with available, state, model, elapsedMs, dim, vectorCount.

## Debugging with Bun Inspector

Run with debugger:

```bash
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts
```

Attach debugger to ws://localhost:6499/. Use `--inspect-wait` or `--inspect-brk` to pause before execution. Export `BUN_OPTIONS` to avoid repeating the URL:

```bash
export BUN_OPTIONS=--inspect=ws://localhost:6499/
bun run --cwd packages/opencode ./src/index.ts
```

## Environment Variables (Dev)

Read from `HORDECODE_*`, fallback to `OPENCODE_*`:

- `HORDECODE_LOG_LEVEL` / `OPENCODE_LOG_LEVEL`: DEBUG, INFO, WARN, ERROR
- `HORDECODE_HOME`: Absolute path to data directory (must be absolute)
- `HORDECODE_DISABLE_AUTOUPDATE`: Set to true to skip auto-update check
- `HORDECODE_PURE`: Disable external plugins (also: `--pure` flag)
- `HORDECODE_EXPERIMENTAL`: Enable experimental features
- `HORDECODE_DISABLE_EMBEDDED_WEB_UI`: Skip web UI embedding in binary (dev/testing)
- `HORDECODE_DISABLE_EXTERNAL_SKILLS`: Disable external skill loading
- `HORDECODE_SERVER_PASSWORD`: Basic auth for serve/web (empty = unsecured)
- `HORDECODE_CONFIG`: Path to custom config file (default: hordecode.json / .hordecode/)

See packages/core/src/flag/flag.ts for comprehensive flag definitions.

## Configuration Files

- `hordecode.json` / `hordecode.jsonc`: Project root config (opencode.json accepted as compat fallback)
- `.hordecode/`: Project-local directory for agents, commands, plugins and plans (`.opencode/` accepted as compat)
- `bunfig.toml`: Build/bun configuration (root level)
- `tsconfig.json`: TypeScript configuration (per-package + root)

## Running Tests Safely

Root test run is banned (OOM-kills, stale-cache):

```bash
# DO NOT DO THIS:
bun test                       # BANNED — will fail

# DO THIS INSTEAD:
cd packages/opencode && bun test
cd packages/core && bun test
```

See bunfig.toml [test] root setting.
