import { Layer, ManagedRuntime } from "effect"

// Worktree boot uses an empty Effect runtime until all
// dependent service layers (Plugin, LSP, File, Format, Snapshot, Bus, Config,
// Memory, History, etc.) are ported and wired. Impact: worktree creation
// succeeds with git state only; per-instance eager init skipped (LSP/Format/
// Plugin cold until first real InstanceStore load recovers lazily). Extra
// signal: project/src/bootstrap.ts:InstanceBootstrap logs a warning so TUI
// and server logs surface the limited-mode condition without blocking
// worktree.ready. Expires: when full bootstrap wiring lands.
// Safe to keep Layer.empty -- no side effects lost beyond deferred init.
export const BootstrapLayer = Layer.empty
export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer)
