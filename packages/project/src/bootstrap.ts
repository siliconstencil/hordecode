import { Effect } from "effect"

// Worktree boot runs through the empty BootstrapRuntime in
// core/src/effect/bootstrap-runtime.ts. Full InstanceBootstrap with all
// service layers lives in opencode/src/project/bootstrap.ts where those
// dependencies are available. This limited-mode stub logs an explicit warning
// (extra signal -- does not replace worktree.ready) so operators and TUI
// logs can detect the cold-bootstrap condition. Worktree creation still
// succeeds; first real session/project request triggers lazy recovery via
// InstanceStore. This is replaced when the project package gains a real
// boot sequence.
export const InstanceBootstrap = Effect.logWarning(
  "worktree bootstrap running in limited mode; Plugin, LSP, File, Format, Snapshot, Bus, Config, Memory, History not eagerly initialized, recovering lazily on first use",
).pipe(Effect.asVoid)
