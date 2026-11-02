// `run` returns from its handler and effect-cmd.ts (PARITY) then disposes the instance with no bound, as does the
// legacy cli/bootstrap.ts (upstream v1.19.5 packages/opencode/src/cli/effect-cmd.ts, cli/bootstrap.ts:9). A disposer that
// never settles would keep the process alive after the answer was printed. This bounds the wait the way upstream's
// tui.ts:265 bounds the worker shutdown (withTimeout(..., 5000)): after the handler returns, the process exits with
// its current exit code once the grace period has passed. The timer is unref'd so a normal exit is never delayed.
export const SHUTDOWN_GRACE_MS = 5000

export function armShutdownWatchdog(input?: { ms?: number; exit?: (code: number) => void }) {
  const exit = input?.exit ?? ((code: number) => process.exit(code))
  const timer = setTimeout(() => exit(typeof process.exitCode === "number" ? process.exitCode : 0), input?.ms ?? SHUTDOWN_GRACE_MS)
  timer.unref?.()
  return timer
}
